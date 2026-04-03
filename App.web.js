import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet, Text, View, FlatList, TouchableOpacity, Image,
  SafeAreaView, Modal, Alert, Platform, TextInput, ActivityIndicator, ScrollView, Linking, Share, useWindowDimensions
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc, getDocs, updateDoc, deleteDoc, getDoc, setDoc, doc, increment, query, where, orderBy, limit, onSnapshot, arrayUnion, arrayRemove, runTransaction } from 'firebase/firestore';
import { getAuth, signInAnonymously, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult } from 'firebase/auth';
// No AdMob on web version

// ------------------- Firebase config -------------------
const firebaseConfig = {
  apiKey: "AIzaSyCfsHn4kUB2XCGe7eaLtLFBtXCzftUXdu4",
  authDomain: "topmeme-jijascuas.firebaseapp.com",
  projectId: "topmeme-jijascuas",
  messagingSenderId: "502124643045",
  appId: "1:502124643045:web:8867880716bed604450a0c"
};

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);
const auth = getAuth(app);
const WEB_URL = 'https://topmeme-jijascuas.web.app/';

// ------------------- Cloudinary config & storage limits -------------------
const CLOUDINARY_CLOUD_NAME   = 'dg8tmvhzn';
const CLOUDINARY_UPLOAD_PRESET = 'topmeme_preset';
const CLOUDINARY_MAX_FILE_BYTES = 10 * 1024 * 1024;          // 10 MB / archivo
const CLOUDINARY_TOTAL_BYTES    = 25 * 1024 * 1024 * 1024;   // 25 GB total (plan gratuito)
const CLEANUP_THRESHOLD         = CLOUDINARY_TOTAL_BYTES * 0.80; // limpiar al 80 %
const CLEANUP_BATCH             = 10;

/**
 * Obtiene un Blob listo para subir.
 * - Si hay base64: lo convierte directamente a Blob (más fiable en APK/WebView).
 * - En web (browser): usa canvas para comprimir y garantizar compatibilidad.
 * - En nativo (Expo Go / React Native): fetch directo del blob URI.
 */
const getBlobForUpload = async (imageUri, base64Data) => {
  // 1. Si tenemos base64, lo usamos directamente para evitar problemas de permisos de archivo
  if (base64Data) {
    const byteCharacters = atob(base64Data);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: 'image/jpeg' });
  }

  if (typeof document !== 'undefined') {
    // ── WEB ──────────────────────────────────────────────────────────────────
    return new Promise((resolve, reject) => {
      const img = new window.Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        let w = img.naturalWidth, h = img.naturalHeight;
        const MAX_PX = 1920;
        if (w > MAX_PX) { h = Math.round(h * MAX_PX / w); w = MAX_PX; }
        if (h > MAX_PX) { w = Math.round(w * MAX_PX / h); h = MAX_PX; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('No se pudo obtener el contexto del canvas'));
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(
          blob => blob ? resolve(blob) : reject(new Error('canvas toBlob falló')),
          'image/jpeg', 0.85
        );
      };
      img.onerror = () => reject(new Error('No se pudo cargar la imagen en el canvas (URI inaccesible)'));
      img.src = imageUri;
    });
  }
  // ── NATIVO ───────────────────────────────────────────────────────────────
  const resp = await fetch(imageUri);
  if (!resp.ok) throw new Error('No se pudo leer el archivo local');
  return resp.blob();
};

/** Sube imagen a Cloudinary. Acepta una AbortSignal para cancelación y un callback onProgress. */
const uploadToCloudinary = (imageUri, base64Data, signal, onProgress) => {
  return new Promise(async (resolve, reject) => {
    // 1. Obtener blob (priorizando base64 para evitar errores de URI en WebView)
    let blob;
    try {
      blob = await getBlobForUpload(imageUri, base64Data);
    } catch (e) {
      return reject({ title: 'Error al procesar la imagen', reason: e.message, suggestion: 'Prueba con otra imagen.' });
    }

    // 2. Comprobar tamaño
    if (blob.size > CLOUDINARY_MAX_FILE_BYTES) {
      return reject({
        title: 'Imagen demasiado grande',
        reason: `El archivo pesa ${(blob.size / 1024 / 1024).toFixed(1)} MB. Límite 10 MB.`,
        suggestion: 'Usa una imagen más pequeña.',
      });
    }

    // 3. Subir usando XMLHttpRequest para tener progreso
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`);

    if (signal) {
      signal.addEventListener('abort', () => xhr.abort());
    }

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        const percentComplete = (e.loaded / e.total) * 100;
        onProgress(percentComplete);
      }
    };

    xhr.onload = () => {
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (ex) {
        return reject({ title: 'Error de respuesta', reason: 'Cloudinary devolvió datos inválidos.' });
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        if (!data.secure_url) {
          reject({ title: 'Respuesta inesperada', reason: 'Cloudinary no devolvió URL.' });
        } else {
          resolve({ url: data.secure_url, bytes: data.bytes || blob.size, publicId: data.public_id });
        }
      } else {
        const msg = data?.error?.message || `HTTP ${xhr.status}`;
        reject({ title: 'Error de Cloudinary', reason: msg, suggestion: 'Revisa tu configuración.' });
      }
    };

    xhr.onerror = () => {
      reject({ title: 'Error de conexión', reason: 'No se pudo conectar con Cloudinary.' });
    };

    xhr.onabort = () => {
      reject({ title: 'Subida cancelada', reason: '', suggestion: '' });
    };

    const formData = new FormData();
    formData.append('file', blob, 'meme.jpg');
    formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
    formData.append('folder', 'topmeme');
    xhr.send(formData);
  });
};

/** Auto-limpieza: borra los memes más antiguos si el almacenamiento supera el 80 %. */
const checkAndCleanupStorage = async () => {
  try {
    const statsRef = doc(db, 'stats', 'storage');
    const snap = await getDoc(statsRef);
    const total = snap.exists() ? (snap.data().totalBytes || 0) : 0;
    if (total < CLEANUP_THRESHOLD) return;
    console.warn(`⚠️ Almacenamiento al ${((total / CLOUDINARY_TOTAL_BYTES) * 100).toFixed(1)}%. Limpiando...`);
    const q = query(collection(db, 'memes'), orderBy('createdAt', 'asc'), limit(CLEANUP_BATCH));
    const oldSnap = await getDocs(q);
    let freed = 0;
    for (const d of oldSnap.docs) { freed += d.data().bytes || 0; await deleteDoc(d.ref); }
    await updateDoc(statsRef, { totalBytes: Math.max(0, total - freed), lastCleanup: new Date(), cleanedMemes: increment(CLEANUP_BATCH) });
    console.log(`✅ ${oldSnap.size} memes deleted, ${(freed / 1024 / 1024).toFixed(1)} MB freed.`);
  } catch (e) { console.error('Auto Cleanup Error:', e); }
};

/** Analyzes the image using Google Cloud Vision API (SafeSearch). Returns true if safe. */
const analyzeImageWithAI = async (base64String) => {
  try {
    const response = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${firebaseConfig.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content: base64String },
          features: [{ type: 'SAFE_SEARCH_DETECTION' }]
        }]
      })
    });
    
    if (!response.ok) {
      if (response.status === 403) {
        throw new Error('Google Cloud Vision API is not enabled in the Google Cloud Console.');
      }
      throw new Error(`Vision API Error: ${response.status}`);
    }

    const data = await response.json();
    const safeSearch = data.responses[0]?.safeSearchAnnotation;
    
    if (!safeSearch) return true; // Si no hay datos, asumimos que está bien (o hubo un error leve)

    // Valores: UNKNOWN, VERY_UNLIKELY, UNLIKELY, POSSIBLE, LIKELY, VERY_LIKELY
    const isUnsafe = (val) => val === 'LIKELY' || val === 'VERY_LIKELY' || val === 'POSSIBLE';

    if (isUnsafe(safeSearch.adult) || isUnsafe(safeSearch.violence) || isUnsafe(safeSearch.racy)) {
      return false; // Contenido inapropiado detectado
    }
    return true; // Imagen limpia
  } catch (e) {
    console.warn('AI Analysis Skipped:', e.message);
    return true; // Si no está habiltiada o falla, permitimos la subida para no fastidiar la UX.
  }
};

// ── Constants & Helpers ───────────────────────────────────────────────────────
const categories = ['Day', 'Week', 'Month', 'Year', 'My Memes'];

let globalShowToast = null;
let globalShowConfirm = null;

const safeAlert = (title, message) => {
  if (globalShowToast) {
    globalShowToast(`${title}: ${message}`);
    return;
  }
  if (Platform.OS === 'web') window.alert(`${title}: ${message}`);
  else Alert.alert(title, message);
};

// ── Auth Screen ───────────────────────────────────────────────────────────────
const AuthScreen = ({ onClose }) => {
  const [email, setEmail]         = useState('');
  const [password, setPassword]   = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [loading, setLoading]     = useState(false);
  const [errorMsg, setErrorMsg]   = useState('');

  // Friendly Firebase error messages
  const getFriendlyError = (code) => {
    const map = {
      'auth/user-not-found':      'No account found with this email.',
      'auth/wrong-password':      'Incorrect password. Please try again.',
      'auth/email-already-in-use':'This email is already registered. Try logging in.',
      'auth/weak-password':       'Password must be at least 6 characters.',
      'auth/invalid-email':       'Please enter a valid email address.',
      'auth/too-many-requests':   'Too many failed attempts. Please try again later.',
      'auth/network-request-failed': 'Network error. Check your connection.',
      'auth/invalid-credential':  'Incorrect email or password.',
    };
    return map[code] || 'Authentication error. Please try again.';
  };

  const handleEmailAuth = async () => {
    if (!email || !password) { setErrorMsg('Please enter your email and password.'); return; }
    setLoading(true);
    setErrorMsg('');
    try {
      if (isRegister) {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
      // DO NOT call onClose() here.
      // The onAuthStateChanged listener in App will detect the new user
      // and the useEffect watching [user, showAuth] will close the modal safely,
      // preventing the race condition that causes the white screen.
    } catch (e) {
      setErrorMsg(getFriendlyError(e.code));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Handle redirect result if user just came back from Google Sign-In
    getRedirectResult(auth).catch(e => {
      // 'auth/no-auth-event' is normal when there's no redirect to process
      if (e.code !== 'auth/no-auth-event' && e.code !== 'auth/popup-closed-by-user') {
        console.error("Auth redirect result error:", e);
        // On some WebViews, this fails due to storage partitioning.
        // We show a more helpful message.
        if (e.message.includes('missing initial state')) {
          safeAlert('Login Error', 'Your device is blocking the secure redirection. Try logging in with email/password instead or use a standard browser.');
        }
      }
    });
  }, []);

  const handleGoogle = async () => {
    // Detect if we are on a mobile device or WebView
    // Most WebView user agents contain "Linux; Android" or "iPhone; CPU iPhone OS"
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);

    setLoading(true);
    try {
      const provider = new GoogleAuthProvider();
      // Optional: force account selection
      provider.setCustomParameters({ prompt: 'select_account' });

      if (isMobile) {
        // Redirection is more stable in WebViews
        await signInWithRedirect(auth, provider);
        // Note: the page will navigate away, the rest of the flow is handled by getRedirectResult in useEffect
      } else {
        await signInWithPopup(auth, provider);
      }
    } catch (e) {
      if (e.code !== 'auth/popup-closed-by-user') safeAlert('Error', e.message);
      setLoading(false);
    }
  };


  return (
    <View style={styles.authContainer}>
      {onClose && (
        <TouchableOpacity style={{ position: 'absolute', top: 40, right: 20, padding: 10, zIndex: 10 }} onPress={onClose}>
          <Text style={{ color: '#aaa', fontSize: 24, fontWeight: 'bold' }}>✕</Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity onPress={() => Linking.openURL('https://pump.fun/coin/6SYj84AfiTydCG1usCGDJZBRmDQ8qj161rtKFD1pump')}>
        <Image source={require('./assets/sidebar_logo.png')} style={{ width: 190, height: 190, marginBottom: 15 }} resizeMode="contain" />
      </TouchableOpacity>
      <Text style={styles.authSubtitle}>{isRegister ? 'Create an account' : 'Log in'}</Text>

      <TextInput style={styles.input} placeholder="Email" placeholderTextColor="#666"
        value={email} onChangeText={t => { setEmail(t); setErrorMsg(''); }} keyboardType="email-address" autoCapitalize="none" />
      <TextInput style={styles.input} placeholder="Password" placeholderTextColor="#666"
        value={password} onChangeText={t => { setPassword(t); setErrorMsg(''); }} secureTextEntry />

      {errorMsg ? (
        <View style={{ width: '100%', maxWidth: 360, backgroundColor: '#2a0a0a', borderRadius: 8, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: '#aa2233' }}>
          <Text style={{ color: '#ff6b6b', fontSize: 14, textAlign: 'center' }}>{errorMsg}</Text>
        </View>
      ) : null}

      {loading ? <ActivityIndicator color="#3897f0" size="large" style={{ marginTop: 20 }} /> : (
        <>
          <TouchableOpacity style={styles.authBtn} onPress={handleEmailAuth}>
            <Text style={styles.authBtnText}>{isRegister ? 'Sign Up' : 'Log In'}</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={() => { setIsRegister(!isRegister); setErrorMsg(''); }} style={{ marginTop: 12 }}>
            <Text style={styles.switchText}>
              {isRegister ? 'Already have an account? Log in' : "Don't have an account? Sign up"}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.googleBtn, { marginTop: 24 }]} onPress={handleGoogle}>
            <Text style={styles.googleBtnText}>G &nbsp;Continue with Google</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
};

// ── Sidebar ───────────────────────────────────────────────────────────────────
const Sidebar = ({ current, onSelect, user, onUpload, onLogout, isLight, onLoginRequest, nickname, setNickname }) => {
  const isGuest = user?.isAnonymous || !user;
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [showNicknameModal, setShowNicknameModal] = useState(false);
  const [tempNickname, setTempNickname] = useState(nickname);

  return (
    <View style={styles.sidebar}>
      <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}>
        <TouchableOpacity style={{ alignItems: 'center', marginTop: 15, marginBottom: 15 }} onPress={() => Linking.openURL('https://pump.fun/coin/6SYj84AfiTydCG1usCGDJZBRmDQ8qj161rtKFD1pump')}>
          <Image source={require('./assets/sidebar_logo.png')} style={{ width: 120, height: 120 }} resizeMode="contain" />
        </TouchableOpacity>
        <Text style={[styles.sidebarUser, { marginBottom: 10, color: '#aaa' }]} numberOfLines={1}>
          {user?.email && !user.isAnonymous ? `👤 ${user.email.split('@')[0]}...` : '👤 Guest'}
        </Text>
        
        {!isGuest && (
          <TouchableOpacity 
            style={styles.nicknameDisplayBtn} 
            activeOpacity={0.7}
            onPress={() => {
              setTempNickname(nickname);
              setShowNicknameModal(true);
            }}
          >
            <Text style={styles.nicknameDisplayText}>👤 {nickname} (Edit)</Text>
          </TouchableOpacity>
        )}

        <Modal visible={showNicknameModal} transparent animationType="slide">
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
            <View style={{ backgroundColor: isLight ? '#fff' : '#1e1e2e', borderRadius: 16, padding: 24, width: '100%', maxWidth: 320, borderWidth: 1, borderColor: isLight ? '#ddd' : '#333' }}>
              <Text style={{ color: isLight ? '#111' : '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 8 }}>Enter your new nickname:</Text>
              <Text style={{ color: isLight ? '#666' : '#888', fontSize: 12, marginBottom: 16 }}>This name will be displayed on your memes.</Text>
              
              <TextInput
                style={{
                  backgroundColor: isLight ? '#f9f9f9' : '#111',
                  color: isLight ? '#111' : '#fff',
                  borderRadius: 10,
                  padding: 12,
                  fontSize: 16,
                  borderWidth: 1,
                  borderColor: isLight ? '#ddd' : '#444',
                  marginBottom: 20
                }}
                value={tempNickname}
                onChangeText={setTempNickname}
                autoFocus
                maxLength={20}
                placeholder="Type nickname..."
                placeholderTextColor="#555"
              />

              <View style={{ flexDirection: 'row', gap: 12 }}>
                <TouchableOpacity 
                  onPress={() => setShowNicknameModal(false)}
                  style={{ flex: 1, padding: 12, borderRadius: 10, alignItems: 'center', backgroundColor: isLight ? '#eee' : '#222' }}
                >
                  <Text style={{ color: isLight ? '#555' : '#aaa', fontWeight: 'bold' }}>Cancel</Text>
                </TouchableOpacity>

                <TouchableOpacity 
                  onPress={() => {
                    const trimmed = tempNickname.trim();
                    if (trimmed) {
                      setNickname(trimmed);
                      setShowNicknameModal(false);
                    }
                  }}
                  style={{ flex: 1, padding: 12, borderRadius: 10, alignItems: 'center', backgroundColor: '#3897f0' }}
                >
                  <Text style={{ color: '#fff', fontWeight: 'bold' }}>Save</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

      {categories.map(cat => (
        <TouchableOpacity
          key={cat} onPress={() => onSelect(cat)}
          style={[styles.menuItem, current === cat && styles.activeMenuItem, isLight && current === cat && { backgroundColor: '#f0f0f0' }]}
        >
          <Text style={[styles.menuText, current === cat && styles.activeMenuText, isLight && current === cat && { color: '#111' }]}>
            {cat === 'My Memes' ? 'My Memes' : `Meme of the ${cat}`}
          </Text>
        </TouchableOpacity>
      ))}

      <TouchableOpacity
        onPress={() => onSelect('PROMOTION')}
        style={[styles.menuItem, current === 'PROMOTION' && styles.activeMenuItem, styles.promoMenuBtn]}
      >
        <Text style={[styles.menuText, current === 'PROMOTION' ? {color: '#fff'} : {color: '#ffd700'}, { fontWeight: 'bold' }]}>
          🌟 PROMOTION
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        onPress={() => onSelect('DONATION')}
        style={[styles.menuItem, styles.donationMenuBtn]}
      >
        <Text style={[styles.menuText, { color: '#4caf50', fontWeight: 'bold' }]}>
          ☕ Support / Donate
        </Text>
      </TouchableOpacity>

      <View style={styles.spacer} />

      <TouchableOpacity style={[styles.ruleBtn, isLight && { backgroundColor: '#f9f9f9', borderColor: '#ddd' }]}
        onPress={() => setShowRulesModal(true)}>
        <Text style={[styles.ruleText, isLight && { color: '#555' }]}>📋 Rules</Text>
      </TouchableOpacity>

      <Modal visible={showRulesModal} transparent animationType="fade">
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          <View style={{ backgroundColor: isLight ? '#fff' : '#1e1e2e', borderRadius: 16, padding: 24, width: '100%', maxWidth: 340 }}>
            <Text style={{ color: isLight ? '#111' : '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 16 }}>📋 App Rules</Text>
            <Text style={{ color: isLight ? '#333' : '#ccc', fontSize: 14, lineHeight: 22 }}>
              {'🤖 Artificial Intelligence rigorously reviews all images before publishing.\n\n🚫 PROHIBITED:\n- Explicit content or nudity.\n- Violence, gore, or weapons.\n- Any illegal activity.\n\n📏 Size limit: 10 MB.\nFormat: JPG, PNG, GIF, WebP.'}
            </Text>
            <TouchableOpacity onPress={() => setShowRulesModal(false)}
              style={{ marginTop: 20, backgroundColor: '#1da1f2', borderRadius: 8, padding: 12, alignItems: 'center' }}>
              <Text style={{ color: '#fff', fontWeight: 'bold' }}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {isGuest ? (
        <TouchableOpacity style={[styles.uploadBtn, { backgroundColor: '#1da1f2' }]} onPress={onLoginRequest}>
          <Text style={styles.uploadText}>Register to Upload</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity style={styles.uploadBtn} onPress={onUpload}>
          <Text style={styles.uploadText}>+ Upload Meme</Text>
        </TouchableOpacity>
      )}

      {!isGuest && (
        <TouchableOpacity style={[styles.logoutBtn, isLight && { backgroundColor: '#ffe5e5', borderColor: '#ffcccc' }]} onPress={onLogout}>
          <Text style={styles.logoutText}>Log out</Text>
        </TouchableOpacity>
      )}

      {!isGuest && (
        <TouchableOpacity
          onPress={() => Linking.openURL('https://topmeme-jijascuas.web.app/delete-account')}
          style={{ marginTop: 8, marginBottom: 4, alignItems: 'center' }}
        >
          <Text style={{ color: '#ff6b6b', fontSize: 12, textDecorationLine: 'underline' }}>🗑️ Delete Account</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity onPress={() => Linking.openURL('https://topmeme-jijascuas.web.app/privacy.html')} style={{ marginTop: 12, marginBottom: 20, alignItems: 'center' }}>
        <Text style={{ color: '#aaa', fontSize: 12, textDecorationLine: 'underline' }}>Privacy Policy</Text>
      </TouchableOpacity>
      </ScrollView>
    </View>
  );
};


const UploadModal = ({ visible, onClose, user, category, nickname: propNickname, isLight }) => {
  const [uploading, setUploading] = useState(false);
  const [imageUri, setImageUri] = useState(null);
  const [imageBase64, setImageBase64] = useState(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [aiAnalyzing, setAiAnalyzing] = useState(false);
  const [paymentProcessing, setPaymentProcessing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [title, setTitle]             = useState('');
  const [giftCode, setGiftCode]       = useState('');
  const [uploadError, setUploadError] = useState(null);
  const abortRef = useRef(null);


  // Siempre funcional: cancela cualquier subida en curso
  const handleClose = () => {
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    setUploading(false);
    setPaymentProcessing(false);
    setAiAnalyzing(false);
    setUploadProgress(0);
    setUploadError(null);
    setImageUri(null);
    setImageBase64(null);
    setPreviewReady(false);
    setGiftCode('');
    setTitle('');
    onClose();
  };

  const pickImage = async () => {
    setUploadError(null);
    setPreviewReady(false);
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') { safeAlert('Permission Denied', 'We need access to your photo gallery.'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.8, 
      base64: true, 
    });
    if (!result.canceled) {
      setImageUri(result.assets[0].uri);
      setImageBase64(result.assets[0].base64);
    }
  };

  const uploadMeme = async (isGift = false) => {
    if (!imageUri || !imageBase64 || !previewReady) { safeAlert('Espera', 'La imagen aún se está precargando.'); return; }
    if (!title.trim()) { safeAlert('Error', 'Escribe un título para tu meme.'); return; }
    
    setUploading(true);
    setUploadProgress(0);
    setUploadError(null);
    abortRef.current = new AbortController();
    
    try {
      // 1. Análisis de IA
      setAiAnalyzing(true);
      const isSafe = await analyzeImageWithAI(imageBase64);
      // Wait a bit to show visually that it's checking
      await new Promise(r => setTimeout(r, 600));
      setAiAnalyzing(false);

      if (!isSafe) {
        setUploading(false);
        setUploadError({
          title: '🚨 Imagen Rechazada 🚨',
          reason: 'Nuestra Inteligencia Artificial ha detectado contenido inapropiado.',
          suggestion: 'Por favor, selecciona una imagen que cumpla las normas.'
        });
        return;
      }

      // 2. Lógica de Pago o Código Regalo
      let requiresStripePayment = (category === 'PROMOTION' || category === 'PROMOCION');

      if (requiresStripePayment && isGift) {
        setPaymentProcessing(true);
        const trimmedCode = giftCode.trim();
        if (!trimmedCode) throw new Error('Introduce un código de regalo.');
        
        const codeRef = doc(db, 'gift_codes', trimmedCode);
        const codeSnap = await getDoc(codeRef);
        
        if (!codeSnap.exists() || codeSnap.data().used) {
          throw new Error('Código inválido o ya usado.');
        }
        
        await updateDoc(codeRef, { used: true, usedBy: user.uid, usedAt: new Date() });
        requiresStripePayment = false;
        setPaymentProcessing(false);
      } else if (requiresStripePayment) {
        setPaymentProcessing(true);
        // We will open the Stripe link AFTER saving the doc to get the doc ID
      }

      // 3. Subida a Cloudinary
      const { url, bytes, publicId } = await uploadToCloudinary(
        imageUri,
        imageBase64,
        abortRef.current.signal, 
        (p) => setUploadProgress(p)
      );

      // --- NEW: Cleanup previous "ON HOLD" memes for this user in PROMOTION category ---
      if (category === 'PROMOTION' || category === 'PROMOCION') {
        try {
          const qHold = query(
            collection(db, 'memes'),
            where('uploadedBy', '==', user.uid),
            where('category', '==', 'PROMOTION'),
            where('approved', '==', false)
          );
          const holdSnap = await getDocs(qHold);
          const deleteOps = holdSnap.docs.map(d => deleteDoc(d.ref));
          await Promise.all(deleteOps);
        } catch (err) {
          console.warn('Silent failure cleaning up old hold memes:', err);
        }
      }

      const docRef = await addDoc(collection(db, 'memes'), {
        title: title.trim(), 
        category: (category === 'PROMOTION' || category === 'PROMOCION') ? 'PROMOTION' : 'general', 
        imageUrl: url,
        publicId, bytes,
        uploadedBy: user.uid, 
        // uploaderEmail: user.email || 'guest', // Email hidden by user request
        author: (propNickname || 'Anonymous').trim(),
        likes: 0, 
        likedBy: [],
        createdAt: new Date(),
        approved: !requiresStripePayment
      });

      if (requiresStripePayment) {
        if (typeof window !== 'undefined' && window.ReactNativeWebView && (window.IS_TOPMEME_APK || navigator.userAgent?.includes("TopmemeAndroidWebView"))) {
           // APK Native Billing Trigger
           window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'PURCHASE',
              productId: 'promotion_10usd',
              docId: docRef.id
           }));
           setPaymentProcessing(false);
           safeAlert('Promotion', 'Meme uploaded. Complete the payment in the pop-up to activate it.');
        } else {
          // Standard Stripe fallback for Web
          const stripeUrl = `https://buy.stripe.com/14A8wI2kn9NJ43n25e1ZS00?client_reference_id=${docRef.id}`;
          if (Platform.OS === 'web') {
            window.location.href = stripeUrl;
            return;
          } else {
            Linking.openURL(stripeUrl);
            setPaymentProcessing(false);
            safeAlert('Promotion', 'Meme uploaded. Waiting for payment to activate it in the ranking.');
          }
        }
      } else {
        safeAlert('Success', 'Meme published successfully!');
      }

      const statsRef = doc(db, 'stats', 'storage');
      setDoc(statsRef, { totalBytes: increment(bytes || 0), totalMemes: increment(1), lastUpload: new Date() }, { merge: true }).catch(console.error);
      
      handleClose();
      checkAndCleanupStorage().catch(console.error);


    } catch (e) {
      if (e?.title === 'Upload cancelled' || e?.title === 'Subida cancelada') { setUploading(false); setPaymentProcessing(false); setAiAnalyzing(false); return; }
      setUploading(false);
      setPaymentProcessing(false);
      setAiAnalyzing(false);
      setUploadProgress(0);
      setUploadError({
        title: e?.title || 'Unexpected Error',
        reason: e?.message || e?.reason || 'Unknown error occurred.',
        suggestion: e?.suggestion || 'Reload the page and try again.',
        raw: e?.raw || e?.message
      });
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={styles.modalOverlay}>
        <View style={styles.uploadModal}>

          {/* Cabecera — el botón ✕ SIEMPRE funciona */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <Text style={styles.uploadModalTitle}>{(category === 'PROMOTION' || category === 'PROMOCION') ? '🌟 Upload to PROMOTION' : 'Upload Meme'}</Text>
            <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
              <Text style={styles.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.uploadModalSub}>
            {category === 'PROMOTION' || category === 'PROMOCION'
              ? 'Feature your meme. Cost: $10' 
              : `Participate in the Global Ranking`}
          </Text>

          <TextInput
            style={styles.input} placeholder="Meme Title" placeholderTextColor="#666"
            value={title} onChangeText={setTitle} maxLength={80} editable={!uploading}
          />

          <View style={{ marginBottom: 12, paddingHorizontal: 4 }}>
            <Text style={{ color: isLight ? '#888' : '#aaa', fontSize: 13 }}>
              Pubishing as: <Text style={{ fontWeight: 'bold', color: '#3897f0' }}>{propNickname || 'Anonymous'}</Text>
            </Text>
          </View>


          <TouchableOpacity style={styles.pickBtn} onPress={pickImage} disabled={uploading}>
            <Text style={styles.pickBtnText}>{imageUri ? '🖼️ Change image' : '🖼️ Select image'}</Text>
          </TouchableOpacity>

          {/* Preview con indicador de precarga */}
          {imageUri && (
            <View style={styles.previewWrap}>
              <Image
                source={{ uri: imageBase64 ? `data:image/jpeg;base64,${imageBase64}` : imageUri }}
                style={styles.previewImage}
                resizeMode="contain"
                onLoad={() => setPreviewReady(true)}
                onError={() => {
                  setPreviewReady(false);
                  setUploadError({ title: 'Imagen inválida', reason: 'No se pudo precargar esta imagen.', suggestion: 'Usa un formato JPG, PNG, GIF o WebP.' });
                }}
              />
              {!previewReady && !uploadError && (
                <View style={styles.previewLoader}>
                  <ActivityIndicator color="#3897f0" />
                  <Text style={{ color: '#aaa', marginTop: 6, fontSize: 12 }}>Loading preview...</Text>
                </View>
              )}
              {previewReady && (
                <View style={styles.previewBadge}>
                  <Text style={styles.previewBadgeText}>✅ Ready to upload</Text>
                </View>
              )}
            </View>
          )}

          {(category === 'PROMOTION' || category === 'PROMOCION') && !uploading && (
            <View style={styles.giftSection}>
              <Text style={styles.giftLabel}>Do you have a gift code?</Text>
              <TextInput 
                style={styles.giftInput} 
                placeholder="GIFT CODE" 
                value={giftCode} 
                onChangeText={setGiftCode} 
                maxLength={100}
                autoCapitalize="none"
              />
              <Text style={styles.underscoreHint}>{'_ '.repeat(15)}</Text>
            </View>
          )}

          {/* Detailed Error Panel */}
          {uploadError && (
            <View style={styles.errorPanel}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <Text style={styles.errorPanelTitle}>❌ {uploadError.title}</Text>
                <TouchableOpacity onPress={() => setUploadError(null)} style={{ padding: 4 }}>
                  <Text style={{ color: '#ff4d6d', fontSize: 16, fontWeight: 'bold' }}>✕</Text>
                </TouchableOpacity>
              </View>
              {uploadError.reason ? <><Text style={styles.errorPanelLabel}>Reason:</Text><Text style={styles.errorPanelText}>{uploadError.reason}</Text></> : null}
              {uploadError.suggestion ? <><Text style={styles.errorPanelLabel}>Suggestion:</Text><Text style={styles.errorPanelText}>{uploadError.suggestion}</Text></> : null}
              {uploadError.raw ? <Text style={styles.errorPanelRaw}>Technical: {uploadError.raw}</Text> : null}
            </View>
          )}

          <View style={{ marginTop: 16 }}>
            {uploading && !uploadError && (
              <View style={styles.progressBarWrap}>
                <View style={[
                  styles.progressBar, 
                  { 
                    width: (aiAnalyzing || paymentProcessing) ? '100%' : `${uploadProgress}%`, 
                    backgroundColor: paymentProcessing ? '#cca000' : (aiAnalyzing ? '#8a2be2' : '#3897f0') 
                  }
                ]} />
                <Text style={styles.progressText}>
                  {aiAnalyzing ? '🤖 IA Analizando...' 
                   : (paymentProcessing ? '💳 Procesando pago...' : `${Math.round(uploadProgress)}% subiendo...`)}
                </Text>
              </View>
            )}

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity style={[styles.cancelBtn, uploading && { opacity: 0.5 }]} onPress={handleClose}>
                <Text style={styles.cancelBtnText}>{uploading ? 'Cancel' : 'Close'}</Text>
              </TouchableOpacity>
              
              {(category === 'PROMOTION' || category === 'PROMOCION') ? (
                <>
                  <TouchableOpacity 
                    style={[styles.giftBtn, (uploading || !previewReady || !title) && { opacity: 0.5 }]} 
                    onPress={() => uploadMeme(true)} 
                    disabled={uploading || !previewReady || !title}
                  >
                    <Text style={styles.giftBtnText}>Use Gift Code</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.uploadBtn, { flex: 1.5, backgroundColor: '#cca000' }, (uploading || !previewReady || !title) && { opacity: 0.5 }]} 
                    onPress={() => uploadMeme(false)}
                    disabled={uploading || !previewReady || !title}
                  >
                    <Text style={styles.uploadText}>Pay $10</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <TouchableOpacity
                  style={[styles.uploadBtn, { flex: 2 }, (uploading || !previewReady || !title) && { opacity: 0.5 }]} 
                  onPress={() => uploadMeme(false)}
                  disabled={uploading || !previewReady || !title}
                >
                  <Text style={styles.uploadText}>🚀 Upload now</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>

        </View>
      </View>
    </Modal>
  );
};

// ── Upload Selection Modal ────────────────────────────────────────────────────
const UploadSelectionModal = ({ visible, onClose, onSelect, isLight }) => {
  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={styles.modalOverlay}>
        <View style={[styles.uploadModal, { maxWidth: 360, backgroundColor: isLight ? '#fff' : '#111' }]}>
          <TouchableOpacity onPress={onClose} style={{ position: 'absolute', top: 15, right: 15, zIndex: 10 }}>
            <Text style={{ color: isLight ? '#000' : '#888', fontSize: 20 }}>✕</Text>
          </TouchableOpacity>
          
          <Text style={[styles.uploadModalTitle, { textAlign: 'center', marginBottom: 20, color: isLight ? '#000' : '#fff' }]}>
            How do you want to upload?
          </Text>
          
          <TouchableOpacity 
            style={[styles.uploadBtn, { marginBottom: 15, paddingVertical: 18, backgroundColor: '#3897f0' }]} 
            onPress={() => onSelect('general')}
          >
            <Text style={[styles.uploadText, { fontSize: 17, marginBottom: 4 }]}>🏆 Meme Ranking</Text>
            <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11 }}>Contribute to the global leaderboard</Text>
          </TouchableOpacity>

          <TouchableOpacity 
            style={[styles.uploadBtn, { backgroundColor: '#ffd700', paddingVertical: 18, borderWidth: 1, borderColor: '#554400' }]} 
            onPress={() => onSelect('PROMOTION')}
          >
            <Text style={[styles.uploadText, { fontSize: 17, color: '#000', marginBottom: 4 }]}>🌟 PROMOTION</Text>
            <Text style={{ color: 'rgba(0,0,0,0.6)', fontSize: 11, fontWeight: 'bold' }}>Pay $10 or use a Gift Code to be featured</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

// ── Donation Modal ──────────────────────────────────────────────────────────
const DonationModal = ({ visible, onClose, isLight }) => {
  const isAndroidWebView = typeof window !== 'undefined' &&
    (window.IS_TOPMEME_APK || navigator.userAgent?.includes('TopmemeAndroidWebView'));

  // On web: go directly to Ko-fi without showing the amount picker
  useEffect(() => {
    if (visible && !isAndroidWebView) {
      Linking.openURL('https://ko-fi.com/jijascuas');
      onClose();
    }
  }, [visible]);

  // Android native billing options
  const donationOptions = [
    { id: 'donate_1', label: '$1 - Coffee', value: 1, icon: '☕' },
    { id: 'donate_5', label: '$5 - Pizza', value: 5, icon: '🍕' },
    { id: 'donate_10', label: '$10 - Full Support', value: 10, icon: '🚀' },
  ];

  const handleDonate = (sku) => {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'PURCHASE', productId: sku }));
    onClose();
  };

  // On web this modal never renders (opened Ko-fi directly above)
  if (!isAndroidWebView) return null;

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={styles.modalOverlay}>
        <View style={[styles.uploadModal, { maxWidth: 340, backgroundColor: isLight ? '#fff' : '#111' }]}>
          <TouchableOpacity onPress={onClose} style={{ position: 'absolute', top: 15, right: 15, zIndex: 10 }}>
            <Text style={{ color: isLight ? '#000' : '#888', fontSize: 20 }}>✕</Text>
          </TouchableOpacity>

          <Text style={[styles.uploadModalTitle, { textAlign: 'center', marginBottom: 8, color: isLight ? '#000' : '#fff' }]}>
            Support Topmeme
          </Text>
          <Text style={{ color: '#888', textAlign: 'center', fontSize: 13, marginBottom: 20 }}>
            Select an amount to help keep the servers running.
          </Text>

          {donationOptions.map(opt => (
            <TouchableOpacity
              key={opt.id}
              style={[styles.uploadBtn, { marginBottom: 10, paddingVertical: 14, backgroundColor: isLight ? '#f9f9f9' : '#1a1a1a', borderWidth: 1, borderColor: isLight ? '#ddd' : '#333' }]}
              onPress={() => handleDonate(opt.id)}
            >
              <Text style={{ color: isLight ? '#000' : '#fff', fontSize: 16, fontWeight: 'bold' }}>{opt.icon} {opt.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    </Modal>
  );
};




// ── Meme Screen — feed estilo Instagram ──────────────────────────────────────
const MemeScreen = ({ category, user, isLight, onLoginRequest, onToggleSidebar, selectedMeme, setSelectedMeme }) => {
  const { width } = useWindowDimensions();
  const numCols = width < 600 ? 3 : (width < 1024 ? 5 : 7);
  const isMobile = width < 768;

  const [memes, setMemes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [likingId, setLikingId] = useState(null);
  // Optimistic like state: { [memeId]: boolean }
  const [localLiked, setLocalLiked] = useState({});
  // Cooldown: { [memeId]: timestamp when cooldown ends }
  const [cooldowns, setCooldowns] = useState({});
  const [cooldownTick, setCooldownTick] = useState(0);

  // Tick every second to update cooldown countdowns
  useEffect(() => {
    const interval = setInterval(() => setCooldownTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!user && category === 'My Memes') {
      setMemes([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    let q;
    try {
      if (category === 'My Memes') {
        q = query(collection(db, 'memes'), where('uploadedBy', '==', user.uid), orderBy('createdAt', 'desc'), limit(100));
      } else if (category === 'PROMOTION') {
        q = query(collection(db, 'memes'), where('category', 'in', ['PROMOTION', 'PROMOCION']), where('approved', '==', true), orderBy('createdAt', 'desc'), limit(100));
      } else {
        q = query(collection(db, 'memes'), where('approved', '==', true), orderBy('createdAt', 'desc'), limit(500));
      }

      const unsub = onSnapshot(q, (snap) => {
        let allMemes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        let filtered = allMemes;
        
        if (category !== 'PROMOTION' && category !== 'My Memes') {
          let hoursAgo = 24;
          if (category === 'Week') hoursAgo = 24 * 7;
          if (category === 'Month') hoursAgo = 24 * 30;
          if (category === 'Year') hoursAgo = 24 * 365;

          const cutoff = Date.now() - (hoursAgo * 60 * 60 * 1000);
          filtered = allMemes.filter(m => {
            if (m.category === 'PROMOTION' || m.category === 'PROMOCION') return false;
            const ts = m.createdAt?.toMillis ? m.createdAt.toMillis() : (m.createdAt ? new Date(m.createdAt).getTime() : 0);
            return ts >= cutoff;
          });
          filtered.sort((a,b) => (b.likes || 0) - (a.likes || 0));
        }
        setMemes(filtered);
        setLoading(false);
      }, (err) => {
        console.error('Snapshot error:', err);
        setLoading(false);
      });
      return () => unsub();
    } catch (e) {
      console.error('Query setup error:', e);
      setLoading(false);
    }
  }, [category, user]);

  const handleLike = async (m) => {
    if (!user || user.isAnonymous) { onLoginRequest(); return; }
    if (likingId) return;

    // Determine current liked state (local optimistic state takes priority)
    const realLiked = m.id in localLiked ? localLiked[m.id] : (m.likedBy || []).includes(user.uid);

    // COOLDOWN CHECK: if the like is active AND cooldown hasn't expired yet → block removal
    if (realLiked && cooldowns[m.id] && Date.now() < cooldowns[m.id]) {
      return; // blocked — the UI already shows the countdown
    }

    // --- OPTIMISTIC UPDATE (instant visual feedback) ---
    setLocalLiked(prev => ({ ...prev, [m.id]: !realLiked }));

    // When GIVING a like → start 1-minute cooldown before it can be removed
    if (!realLiked) {
      const cooldownEnd = Date.now() + 60 * 1000;
      setCooldowns(prev => ({ ...prev, [m.id]: cooldownEnd }));
    } else {
      // When REMOVING a like (after cooldown) → clear the cooldown
      setCooldowns(prev => { const n = { ...prev }; delete n[m.id]; return n; });
    }

    setLikingId(m.id);
    try {
      const currentLikes = m.likes || 0;
      const newLikes = realLiked ? Math.max(0, currentLikes - 1) : currentLikes + 1;
      await updateDoc(doc(db, 'memes', m.id), {
        likes: newLikes,
        likedBy: realLiked ? arrayRemove(user.uid) : arrayUnion(user.uid)
      });
    } catch (e) {
      console.error('Like error:', e);
      // Revert optimistic update on error
      setLocalLiked(prev => ({ ...prev, [m.id]: realLiked }));
      setCooldowns(prev => { const n = { ...prev }; delete n[m.id]; return n; });
    }
    setLikingId(null);
  };

  const shareMeme = async (m) => {
    const url = `${WEB_URL}?meme=${m.id}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: m.title || 'Topmeme', text: `Check out this meme! "${m.title}"`, url });
      } else {
        const text = encodeURIComponent(`Check out this meme! "${m.title}"\n`);
        const link = encodeURIComponent(url);
        window.open(`https://twitter.com/intent/tweet?text=${text}&url=${link}`, '_blank');
      }
    } catch (e) { if (e.name !== 'AbortError') console.error('Share error:', e); }
  };

  const deleteMeme = async (m) => {
    if (!user || user.uid !== m.uploadedBy) return;
    const confirmed = window.confirm(`Delete "${m.title}"? This cannot be undone.`);
    if (!confirmed) return;
    try {
      await deleteDoc(doc(db, 'memes', m.id));
      setSelectedMeme(null);
      if (globalShowToast) globalShowToast('🗑️ Meme deleted.');
    } catch (e) { console.error('Delete error:', e); }
  };

  try {
    if (loading) return (
      <View style={[styles.content, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color="#3897f0" size="large" />
        <Text style={{ color: '#aaa', marginTop: 12 }}>⌛ Loading memes...</Text>
      </View>
    );

    const isPromotion = (m) => m.category === 'PROMOTION' || m.category === 'PROMOCION';
    const isOnHold    = (m) => isPromotion(m) && !m.approved;
    const isPromoted  = (m) => isPromotion(m) && m.approved;

    return (
      <View style={[styles.content, isLight && { backgroundColor: '#f0f2f5' }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10, paddingBottom: 5, borderBottomWidth: 1, borderBottomColor: isLight ? '#eee' : '#222' }}>
          {isMobile && (
            <TouchableOpacity onPress={onToggleSidebar} style={{ padding: 10, marginRight: 10, backgroundColor: '#3897f0', borderRadius: 8 }}>
              <Text style={{ fontSize: 20, color: '#fff' }}>☰</Text>
            </TouchableOpacity>
          )}
          <Text style={[styles.headerTitle, isLight && { color: '#111' }, category === 'PROMOTION' && { color: '#ffd700' }, { marginBottom: 0, flex: 1, fontSize: 18 }]}>
            {category === 'PROMOTION' ? '🌟 PROMOTION' : (category === 'My Memes' ? '👤 My Memes' : `🏆 ${category} Top`)}
          </Text>
        </View>

        {memes.length === 0 ? (
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20 }}>
            <Text style={[styles.emptyText, isLight && { color: '#666' }, { fontSize: 22, textAlign: 'center' }]}>
              {category === 'PROMOTION' ? '🌟 No promotions yet' : (category === 'My Memes' ? '📂 No memes uploaded yet' : '🏚️ No memes in this period')}
            </Text>
            <TouchableOpacity style={{ marginTop: 25, backgroundColor: '#3897f0', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 10 }} onPress={onToggleSidebar}>
              <Text style={{ color: '#fff', fontWeight: 'bold' }}>Change Category ☰</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <FlatList
            data={memes}
            keyExtractor={m => m.id}
            numColumns={numCols}
            columnWrapperStyle={styles.gridRow}
            key={`grid-${numCols}`}
            showsVerticalScrollIndicator={false}
            renderItem={({ item: m }) => (
              <TouchableOpacity
                style={[styles.gridCell, { maxWidth: `${(100 / numCols).toFixed(2)}%` }, isLight && { backgroundColor: '#fff', borderColor: '#e0e0e0' }]}
                onPress={() => setSelectedMeme(m)}
              >
                <Image source={{ uri: m.imageUrl || m.url }} style={styles.gridThumb} resizeMode="cover" />

                {/* Badge: Promotion or Hold status */}
                {(isPromotion(m) || (category === 'My Memes' && !m.approved && isPromotion(m))) && (
                  <View style={{
                    position: 'absolute', top: 4, left: 4,
                    backgroundColor: isOnHold(m) ? 'rgba(255,77,109,0.85)' : 'rgba(255,215,0,0.9)',
                    borderRadius: 8, paddingHorizontal: 5, paddingVertical: 2
                  }}>
                    <Text style={{ fontSize: 10, fontWeight: 'bold', color: isOnHold(m) ? '#fff' : '#000' }}>
                      {isOnHold(m) ? '⏳ HOLD' : '🌟'}
                    </Text>
                  </View>
                )}

                <View style={[styles.gridLikesBadge, isLight && { backgroundColor: 'rgba(255,255,255,0.85)' }]}>
                  <Text style={[styles.gridLikesText, isLight && { color: '#000' }]}>{(m.likedBy || []).includes(user?.uid) ? '❤️' : '🤍'} {m.likes || 0}</Text>
                </View>
              </TouchableOpacity>
            )}
          />
        )}

        <Modal visible={!!selectedMeme} transparent animationType="fade" onRequestClose={() => setSelectedMeme(null)}>
          <TouchableOpacity activeOpacity={1} style={styles.detailOverlay} onPress={() => setSelectedMeme(null)}>
            {selectedMeme && (
              <>
                <TouchableOpacity
                  style={{ position: 'absolute', top: 20, right: 20, zIndex: 20, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 20, width: 36, height: 36, justifyContent: 'center', alignItems: 'center' }}
                  onPress={() => setSelectedMeme(null)}
                >
                  <Text style={{ color: '#fff', fontSize: 18, fontWeight: 'bold' }}>✕</Text>
                </TouchableOpacity>

                <View
                  onStartShouldSetResponder={() => true}
                  style={{ width: '95%', maxWidth: 800, backgroundColor: isLight ? '#fff' : '#111', borderRadius: 20, overflow: 'hidden', maxHeight: '95%' }}
                >
                  <Image
                    source={{ uri: selectedMeme.imageUrl || selectedMeme.url }}
                    style={{ width: '100%', height: undefined, aspectRatio: 16/9, minHeight: 300, maxHeight: 600, backgroundColor: '#000' }}
                    resizeMode="contain"
                  />
                  <View style={[styles.detailMeta, isLight && { backgroundColor: '#fff' }]}>
                    <Text style={[styles.detailTitle, isLight && { color: '#111' }]}>{selectedMeme.title}</Text>
                    {selectedMeme.author ? (
                      <Text style={{ color: isLight ? '#888' : '#666', fontSize: 12, marginTop: 2 }}>by {selectedMeme.author}</Text>
                    ) : null}

                    {/* Status badge for Promotion / ON HOLD */}
                    {isPromotion(selectedMeme) && (
                      <View style={[styles.statusBadge, { backgroundColor: isOnHold(selectedMeme) ? '#ff4d6d' : '#ffd700', marginTop: 10 }]}>
                        <Text style={[styles.statusBadgeText, { color: isOnHold(selectedMeme) ? '#fff' : '#000' }]}>
                          {isOnHold(selectedMeme) ? '⏳ PAYMENT ON HOLD' : '🌟 PROMOTED MEME'}
                        </Text>
                      </View>
                    )}

                    {/* Action buttons row */}
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                      {/* Like */}
                      {(() => {
                        const isLikedLocal = selectedMeme.id in localLiked ? localLiked[selectedMeme.id] : (selectedMeme.likedBy || []).includes(user?.uid);
                        const cdEnd = cooldowns[selectedMeme.id];
                        const remaining = cdEnd ? Math.max(0, Math.ceil((cdEnd - Date.now()) / 1000)) : 0;
                        const inCooldown = isLikedLocal && remaining > 0;
                        return (
                          <>
                            <TouchableOpacity
                              style={[styles.detailLikeBtn, { flex: 1, minWidth: 90 },
                                isLikedLocal && { borderColor: '#ff4d6d', backgroundColor: '#3d0010' },
                                inCooldown && { opacity: 0.6 }
                              ]}
                              onPress={() => handleLike(selectedMeme)}
                              disabled={!!likingId || inCooldown}
                            >
                              <Text style={[styles.detailLikeText, { fontSize: 22 }]}>
                                {isLikedLocal ? '❤️' : '🤍'}
                              </Text>
                            </TouchableOpacity>
                            {inCooldown && (
                              <View style={{ width: '100%', marginTop: 6, backgroundColor: '#1a0a00', borderRadius: 8, padding: 8, borderWidth: 1, borderColor: '#ff6b00', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                                <Text style={{ fontSize: 16 }}>⏳</Text>
                                <Text style={{ color: '#ffaa44', fontSize: 13, fontWeight: 'bold' }}>
                                  You can remove this like in {remaining}s
                                </Text>
                              </View>
                            )}
                          </>
                        );
                      })()}

                      {/* Share */}
                      <TouchableOpacity
                        style={[styles.detailLikeBtn, { flex: 1, minWidth: 90, borderColor: '#4caf50' }]}
                        onPress={() => shareMeme(selectedMeme)}
                      >
                        <Text style={[styles.detailLikeText, { color: '#4caf50' }]}>📤 Share</Text>
                      </TouchableOpacity>

                      {/* Post on X/Twitter */}
                      <TouchableOpacity
                        style={[styles.detailLikeBtn, { flex: 1, minWidth: 90, borderColor: '#1da1f2' }]}
                        onPress={() => {
                          const text = encodeURIComponent(`Like this meme so it appears at the top of the ranking! "${selectedMeme.title}"\n`);
                          const link = encodeURIComponent(`${WEB_URL}?meme=${selectedMeme.id}`);
                          window.open(`https://twitter.com/intent/tweet?text=${text}&url=${link}`, '_blank');
                        }}
                      >
                        <Text style={[styles.detailLikeText, { color: '#1da1f2' }]}>𝕏 Post</Text>
                      </TouchableOpacity>
                    </View>

                    {/* Delete — only for the meme's owner */}
                    {user && user.uid === selectedMeme.uploadedBy && (
                      <TouchableOpacity
                        style={[styles.detailLikeBtn, { marginTop: 10, borderColor: '#f44', backgroundColor: '#1a0000', width: '100%' }]}
                        onPress={() => deleteMeme(selectedMeme)}
                      >
                        <Text style={[styles.detailLikeText, { color: '#f44', fontSize: 13 }]}>🗑️ Delete Meme</Text>
                      </TouchableOpacity>
                    )}

                    <TouchableOpacity onPress={() => setSelectedMeme(null)} style={{ marginTop: 16, alignSelf: 'center', paddingVertical: 8 }}>
                      <Text style={{ color: isLight ? '#888' : '#555', fontSize: 13 }}>Close</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </>
            )}
          </TouchableOpacity>
        </Modal>
      </View>
    );
  } catch (err) {
    return <View style={{ flex: 1, backgroundColor: '#300', justifyContent: 'center' }}><Text style={{ color: '#fff', textAlign: 'center' }}>Crash: {err.message}</Text></View>;
  }
};

// ── END OF FILE

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  console.log('Topmeme Web: Rendering App component...');
  const { width } = useWindowDimensions();
  const isMobile = width < 768;

  const [user, setUser]                   = useState(null);
  const [authLoading, setAuthLoading]     = useState(true);
  const [currentCategory, setCurrentCategory] = useState('Day');
  const [showUpload, setShowUpload]       = useState(false);
  const [showUploadSelection, setShowUploadSelection] = useState(false);
  const [uploadTargetCategory, setUploadTargetCategory] = useState('general');
  const [showDonation, setShowDonation]   = useState(false);
  const [selectedMeme, setSelectedMeme]   = useState(null);
  const [isLight, setIsLight]             = useState(false);
  const [showAuth, setShowAuth]           = useState(false);
  const [toast, setToast]                 = useState(null);
  const toastTimeout                      = useRef(null);
  const [confirmData, setConfirmData]     = useState(null);
  const [sidebarVisible, setSidebarVisible] = useState(!isMobile);

  const [nickname, setNickname] = useState(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        return localStorage.getItem('topmeme_nickname') || 'Anonymous';
      }
    } catch(e) {}
    return 'Anonymous';
  });

  const showToast = (msg) => {
    if (toastTimeout.current) clearTimeout(toastTimeout.current);
    setToast(msg);
    toastTimeout.current = setTimeout(() => setToast(null), 4000);
  };

  const handleLogout = async () => {
    try {
       await signOut(auth);
       showToast('Logged out successfully');
    } catch (e) {
       safeAlert('Error', e.message);
    }
  };

  useEffect(() => {
    globalShowToast = showToast;
    globalShowConfirm = setConfirmData;
    return () => { globalShowToast = null; globalShowConfirm = null; };
  }, []);

  useEffect(() => {
    const handleNativeMessage = (event) => {
      try {
        const data = JSON.parse(typeof event.data === 'string' ? event.data : '{}');
        if (data.type === 'PURCHASE_SUCCESS') {
          if (data.productId === 'promotion_10usd' && data.docId) {
            updateDoc(doc(db, 'memes', data.docId), { approved: true })
              .then(() => showToast('🌟 Promotion activated!'))
              .catch(() => showToast('Payment OK! Approval pending...'));
          } else {
            showToast('❤️ Thank you for your support!');
          }
        }
      } catch (e) {}
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('message', handleNativeMessage);
      document.addEventListener('message', handleNativeMessage);
    }
    return () => {
      window.removeEventListener('message', handleNativeMessage);
      document.removeEventListener('message', handleNativeMessage);
    };
  }, []);

  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, u => { 
      if (!u) {
        setUser(null);
        signInAnonymously(auth).catch(() => setAuthLoading(false));
      } else {
        setUser(u); 
        setAuthLoading(false); 
      }
    });
    return () => unsubAuth();
  }, []);

  useEffect(() => {
    if (!isMobile) setSidebarVisible(true);
  }, [isMobile]);

  useEffect(() => {
    if (user && !user.isAnonymous && showAuth) setShowAuth(false);
  }, [user, showAuth]);

  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.setItem('topmeme_nickname', nickname);
      }
    } catch(e) {}
  }, [nickname]);

  try {
    if (authLoading) return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color="#3897f0" size="large" />
        <Text style={{ color: '#aaa', marginTop: 12 }}>🚀 Starting Topmeme...</Text>
      </View>
    );

    return (
      <SafeAreaView style={[styles.container, isLight && { backgroundColor: '#f0f2f5' }]}>
        <View style={styles.appContainer}>
          {sidebarVisible && (
            <View style={[
              styles.sidebarWrapper, 
              isMobile && { position: 'absolute', zIndex: 1000, height: '100%', width: 250, borderRightWidth: 1, borderColor: '#333' }
            ]}>
              <Sidebar
                current={currentCategory}
                onSelect={(cat) => {
                  if (cat === 'DONATION') setShowDonation(true);
                  else setCurrentCategory(cat);
                  if (isMobile) setSidebarVisible(false);
                }}
                user={user}
                onUpload={() => user?.isAnonymous ? setShowAuth(true) : setShowUploadSelection(true)}
                onLogout={handleLogout}
                isLight={isLight}
                onLoginRequest={() => setShowAuth(true)}
                nickname={nickname}
                setNickname={setNickname}
              />
            </View>
          )}
          <MemeScreen 
            category={currentCategory} 
            user={user} 
            isLight={isLight} 
            onLoginRequest={() => setShowAuth(true)} 
            onToggleSidebar={() => setSidebarVisible(!sidebarVisible)}
            selectedMeme={selectedMeme}
            setSelectedMeme={setSelectedMeme}
          />
        </View>

        {showUploadSelection && (
           <UploadSelectionModal 
             visible={showUploadSelection}
             onClose={() => setShowUploadSelection(false)}
             isLight={isLight}
             onSelect={(mode) => {
               setUploadTargetCategory(mode);
               setShowUploadSelection(false);
               setShowUpload(true);
             }}
           />
        )}

        {showUpload && (
          <UploadModal 
            visible={showUpload} 
            onClose={() => setShowUpload(false)} 
            user={user} 
            category={uploadTargetCategory} 
            nickname={nickname}
            isLight={isLight}
          />
        )}

        {showDonation && (
          <DonationModal visible={showDonation} onClose={() => setShowDonation(false)} isLight={isLight} />
        )}

        {showAuth && (
           <Modal visible={showAuth} transparent animationType="slide" onRequestClose={() => setShowAuth(false)}>
             <AuthScreen onClose={() => setShowAuth(false)} />
           </Modal>
        )}

        {toast && (
          <View style={styles.toastContainer}>
             <Text style={styles.toastText}>{toast}</Text>
          </View>
        )}
      </SafeAreaView>
    );
  } catch (err) {
    console.error('App Render Error:', err);
    return (
      <View style={{ flex: 1, backgroundColor: '#500', justifyContent: 'center', alignItems: 'center' }}>
        <Text style={{ color: '#fff', fontSize: 20 }}>Fatal Error: {err.message}</Text>
        <TouchableOpacity onPress={() => window.location.reload()} style={{ marginTop: 20, padding: 10, backgroundColor: '#fff' }}>
          <Text style={{ color: '#500' }}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  // Layout
  container:    { flex: 1, backgroundColor: '#000' },
  appContainer: { flex: 1, flexDirection: 'row' },
  toastContainer: { position: 'absolute', bottom: 30, left: 20, right: 20, backgroundColor: 'rgba(0,0,0,0.8)', padding: 12, borderRadius: 10, alignItems: 'center' },
  toastText: { color: '#fff', fontSize: 14 },

  // Sidebar
  sidebarWrapper: { backgroundColor: '#111' },
  sidebar:        { width: 250, backgroundColor: '#111', padding: 20, borderRightWidth: 1, borderColor: '#222', minHeight: '100%'},

  // Auth
  authContainer: { flex: 1, backgroundColor: '#0a0a0a', justifyContent: 'center', alignItems: 'center', padding: 30 },
  authSubtitle:  { fontSize: 18, color: '#aaa', marginBottom: 30 },
  input:         { width: '100%', maxWidth: 360, backgroundColor: '#1a1a1a', color: '#fff', padding: 14, borderRadius: 12, marginBottom: 12, fontSize: 16, borderWidth: 1, borderColor: '#333' },
  authBtn:       { width: '100%', maxWidth: 360, backgroundColor: '#3897f0', padding: 16, borderRadius: 12, alignItems: 'center', marginTop: 4 },
  authBtnText:   { color: '#fff', fontWeight: 'bold', fontSize: 17 },
  switchText:    { color: '#3897f0', fontSize: 14, marginTop: 4 },
  googleBtn:     { width: '100%', maxWidth: 360, backgroundColor: '#fff', padding: 16, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: '#ddd' },
  googleBtnText: { color: '#222', fontWeight: '700', fontSize: 16 },

  // Sidebar Items
  sidebarUser:    { fontSize: 13, color: '#bbb', marginLeft: 15 },
  nicknameDisplayBtn: { backgroundColor: '#1e1e1e', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, alignSelf: 'flex-start', marginLeft: 15, marginBottom: 20, borderWidth: 1, borderColor: '#333' },
  nicknameDisplayText: { color: '#3897f0', fontSize: 13, fontWeight: 'bold' },
  menuItem:       { paddingVertical: 13, paddingHorizontal: 10, borderRadius: 10, marginBottom: 4 },
  activeMenuItem: { backgroundColor: '#1e1e1e' },
  promoMenuBtn:   { marginTop: 12, backgroundColor: '#141400', borderWidth: 1, borderColor: '#554400' },
  donationMenuBtn:{ marginTop: 8, backgroundColor: '#0a1d0f', borderWidth: 1, borderColor: '#1b5e20' },
  menuText:       { fontSize: 15, color: '#777', fontWeight: '500' },
  activeMenuText: { color: '#fff' },
  spacer:         { flex: 1 },
  ruleBtn:        { backgroundColor: '#1a1a1a', padding: 12, borderRadius: 10, alignItems: 'center', marginBottom: 8, borderWidth: 1, borderColor: '#333' },
  ruleText:       { color: '#aaa', fontSize: 14 },
  uploadBtn:      { backgroundColor: '#3897f0', padding: 14, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  uploadText:     { color: '#fff', fontWeight: 'bold', fontSize: 15, textAlign: 'center' },
  logoutBtn:      { backgroundColor: '#200000', padding: 12, borderRadius: 10, alignItems: 'center', marginTop: 8, borderWidth: 1, borderColor: '#500' },
  logoutText:     { color: '#f44', fontSize: 14 },

  // Feed ÔÇö Grid Instagram
  content:     { flex: 1, padding: 16, backgroundColor: '#000' },
  headerTitle: { fontSize: 22, fontWeight: 'bold', color: '#fff', marginBottom: 4 },
  disclaimerText:{ fontSize: 11, color: '#aaa', fontStyle: 'italic', marginBottom: 12 },
  emptyText:   { fontSize: 28, color: '#333', textAlign: 'center' },
  gridRow:     { gap: 8, marginBottom: 8, justifyContent: 'flex-start' },
  gridCell:    { flex: 1, aspectRatio: 1, position: 'relative', overflow: 'hidden', borderRadius: 8, backgroundColor: '#111', borderWidth: 1, borderColor: '#222' },
  gridThumb:   { width: '100%', height: '100%' },
  gridLikesBadge: { position: 'absolute', top: 6, right: 6, backgroundColor: 'rgba(0,0,0,0.7)', paddingHorizontal: 6, paddingVertical: 4, borderRadius: 12 },
  gridLikesText:  { color: '#fff', fontSize: 11, fontWeight: '700' },
  statusBadge: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, marginBottom: 16, backgroundColor: '#333' },
  statusBadgeText: { fontSize: 13, fontWeight: 'bold', color: '#fff' },

  // Detail modal
  detailOverlay:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center', alignItems: 'center' },
  detailImage:     { width: '100%', height: '100%' },
  detailMeta:      { padding: 20, width: '100%' },
  detailTitle:     { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  detailLikeBtn:   { padding: 12, borderRadius: 10, borderWidth: 1, borderColor: '#333', marginTop: 10 },
  detailLikeText:  { color: '#fff', textAlign: 'center' },

  // Upload Modal
  modalOverlay:    { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  uploadModal:     { width: '100%', maxWidth: 440, backgroundColor: '#111', borderRadius: 20, padding: 24, borderWidth: 1, borderColor: '#2a2a2a' },
  uploadModalTitle:{ fontSize: 22, fontWeight: 'bold', color: '#fff', marginBottom: 4 },
  uploadModalSub:  { fontSize: 14, color: '#555', marginBottom: 18 },
  pickBtn:         { backgroundColor: '#1a1a1a', padding: 14, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: '#333', marginBottom: 12 },
  pickBtnText:     { color: '#3897f0', fontWeight: '600', fontSize: 15 },
  previewWrap:     { marginTop: 4, marginBottom: 4 },
  previewImage:    { width: '100%', height: 180, borderRadius: 12 },
  previewLoader:   { alignItems: 'center', marginTop: 8 },
  previewBadge:    { marginTop: 6, alignItems: 'center' },
  previewBadgeText:{ color: '#4caf50', fontSize: 12, fontWeight: '700' },
  cancelBtn:       { flex: 1, backgroundColor: '#1a1a1a', padding: 14, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#333' },
  cancelBtnText:   { color: '#aaa', fontSize: 15, textAlign: 'center' },
  closeBtn:        { padding: 6 },
  closeBtnText:    { color: '#aaa', fontSize: 20, fontWeight: 'bold' },

  // Error panel
  errorPanel:      { backgroundColor: '#1a0509', borderWidth: 1, borderColor: '#5a1020', borderRadius: 12, padding: 14, marginTop: 14 },
  errorPanelTitle: { color: '#ff4d6d', fontWeight: 'bold', fontSize: 15, marginBottom: 8 },
  errorPanelLabel: { color: '#aa3344', fontSize: 11, fontWeight: '700', textTransform: 'uppercase', marginTop: 6, marginBottom: 2 },
  errorPanelText:  { color: '#dda0aa', fontSize: 13 },
  errorPanelRaw:   { color: '#664455', fontSize: 10, marginTop: 8, fontStyle: 'italic' },

  // Progress Bar
  progressBarWrap: { width: '100%', height: 24, backgroundColor: '#1a1a1a', borderRadius: 12, overflow: 'hidden', marginBottom: 12, justifyContent: 'center', borderWidth: 1, borderColor: '#333' },
  progressBar:     { height: '100%', backgroundColor: '#3897f0' },
  progressText:    { position: 'absolute', width: '100%', textAlign: 'center', color: '#fff', fontSize: 11, fontWeight: 'bold' },

  // Gift Section
  giftSection: { marginTop: 10, padding: 12, backgroundColor: '#1a1a00', borderRadius: 12, borderStyle: 'dashed', borderWidth: 1, borderColor: '#554400' },
  giftLabel: { fontSize: 11, color: '#aa8800', marginBottom: 4, textAlign: 'center' },
  giftInput: { fontSize: 18, fontWeight: 'bold', color: '#ffd700', textAlign: 'center', letterSpacing: 2 },
  underscoreHint: { textAlign: 'center', color: '#332200', fontSize: 10, marginTop: -4 },
  giftBtn: { backgroundColor: '#ffd700', paddingVertical: 14, borderRadius: 10, flex: 1, alignItems: 'center', justifyContent: 'center' },
  giftBtnText: { color: '#000', fontWeight: 'bold', fontSize: 14, textAlign: 'center' },
});
