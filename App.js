import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet, Text, View, FlatList, TouchableOpacity, Image,
  SafeAreaView, Modal, Alert, Platform, TextInput, ActivityIndicator, ScrollView, Linking, Share
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc, getDocs, updateDoc, deleteDoc, getDoc, setDoc, doc, increment, query, orderBy, limit, onSnapshot, arrayUnion, arrayRemove, runTransaction, where } from 'firebase/firestore';
import { getAuth, signInAnonymously, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { BannerAd, BannerAdSize, InterstitialAd, AdEventType } from './AdHelpers';

const bannerAdUnitId = Platform.OS === 'android' ? 'ca-app-pub-4159023709825629/4936458139' : '';
const interstitialAdUnitId = Platform.OS === 'android' ? 'ca-app-pub-4159023709825629/2066752210' : '';
const interstitial = Platform.OS === 'android' ? InterstitialAd.createForAdRequest(interstitialAdUnitId) : null;

// ── Firebase config ──────────────────────────────────────────────────────────
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

// ── Cloudinary config & storage limits ───────────────────────────────────────
const CLOUDINARY_CLOUD_NAME   = 'dg8tmvhzn';
const CLOUDINARY_UPLOAD_PRESET = 'topmeme_preset';
const CLOUDINARY_MAX_FILE_BYTES = 10 * 1024 * 1024;          // 10 MB / archivo
const CLOUDINARY_TOTAL_BYTES    = 25 * 1024 * 1024 * 1024;   // 25 GB total (plan gratuito)
const CLEANUP_THRESHOLD         = CLOUDINARY_TOTAL_BYTES * 0.80; // limpiar al 80 %
const CLEANUP_BATCH             = 10;

/**
 * Obtiene un Blob listo para subir.
 * - En web (browser): usa canvas → JPEG 85 % para comprimir y garantizar compatibilidad.
 * - En nativo (Expo Go / React Native): fetch directo del blob URI.
 */
const getBlobForUpload = async (imageUri) => {
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
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob(
          blob => blob ? resolve(blob) : reject(new Error('canvas toBlob falló')),
          'image/jpeg', 0.85
        );
      };
      img.onerror = () => reject(new Error('No se pudo cargar la imagen en el canvas'));
      img.src = imageUri;
    });
  }
  // ── NATIVO ───────────────────────────────────────────────────────────────
  const resp = await fetch(imageUri);
  if (!resp.ok) throw new Error('No se pudo leer el archivo local');
  return resp.blob();
};

/** Sube imagen a Cloudinary. Acepta una AbortSignal para cancelación y un callback onProgress. */
const uploadToCloudinary = (imageUri, signal, onProgress) => {
  return new Promise(async (resolve, reject) => {
    // 1. Obtener blob (con compresión en web)
    let blob;
    try {
      blob = await getBlobForUpload(imageUri);
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
    console.warn(`⚠️ Almacenamiento al ${((total / CLOUDINARY_TOTAL_BYTES) * 100).toFixed(1)}%. Limpiando…`);
    const q = query(collection(db, 'memes'), orderBy('createdAt', 'asc'), limit(CLEANUP_BATCH));
    const oldSnap = await getDocs(q);
    let freed = 0;
    for (const d of oldSnap.docs) { freed += d.data().bytes || 0; await deleteDoc(d.ref); }
    await updateDoc(statsRef, { totalBytes: Math.max(0, total - freed), lastCleanup: new Date(), cleanedMemes: increment(CLEANUP_BATCH) });
    console.log(`✅ ${oldSnap.size} memes eliminados, ${(freed / 1024 / 1024).toFixed(1)} MB liberados.`);
  } catch (e) { console.error('Limpieza automática:', e); }
};

/** Analiza la imagen usando Google Cloud Vision API (SafeSearch). Devuelve true si es segura. */
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
        throw new Error('La API de Cloud Vision no está habilitada en la consola de Google Cloud.');
      }
      throw new Error(`Error de visión API: ${response.status}`);
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

const safeAlert = (title, message) => {
  if (Platform.OS === 'web') window.alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
};

// ── Auth Screen ───────────────────────────────────────────────────────────────
const AuthScreen = ({ onClose }) => {
  const [email, setEmail]         = useState('');
  const [password, setPassword]   = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [loading, setLoading]     = useState(false);

  const handleEmailAuth = async () => {
    if (!email || !password) { safeAlert('Error', 'Enter your email and password.'); return; }
    setLoading(true);
    try {
      if (isRegister) await createUserWithEmailAndPassword(auth, email, password);
      else            await signInWithEmailAndPassword(auth, email, password);
    } catch (e) { safeAlert('Error', e.message); }
    setLoading(false);
  };

  const handleGoogle = async () => {
    setLoading(true);
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (e) {
      if (e.code !== 'auth/popup-closed-by-user') safeAlert('Error', e.message);
    }
    setLoading(false);
  };

  

  return (
    <View style={styles.authContainer}>
      {onClose && (
        <TouchableOpacity style={{ position: 'absolute', top: 40, right: 20, padding: 10, zIndex: 10 }} onPress={onClose}>
          <Text style={{ color: '#aaa', fontSize: 24, fontWeight: 'bold' }}>✕</Text>
        </TouchableOpacity>
      )}
      <Text style={styles.authLogo}>🔥 Topmeme</Text>
      <Text style={styles.authSubtitle}>{isRegister ? 'Create an account' : 'Log in'}</Text>

      <TextInput style={styles.input} placeholder="Email" placeholderTextColor="#666"
        value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
      <TextInput style={styles.input} placeholder="Password" placeholderTextColor="#666"
        value={password} onChangeText={setPassword} secureTextEntry />

      {loading ? <ActivityIndicator color="#3897f0" size="large" style={{ marginTop: 20 }} /> : (
        <>
          <TouchableOpacity style={styles.authBtn} onPress={handleEmailAuth}>
            <Text style={styles.authBtnText}>{isRegister ? 'Sign Up' : 'Log In'}</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={() => setIsRegister(!isRegister)} style={{ marginTop: 12 }}>
            <Text style={styles.switchText}>
              {isRegister ? 'Already have an account? Log in' : "Don't have an account? Sign up"}
            </Text>
          </TouchableOpacity>

          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or</Text>
            <View style={styles.dividerLine} />
          </View>

          <TouchableOpacity style={styles.googleBtn} onPress={handleGoogle}>
            <Text style={styles.googleBtnText}>🇬 &nbsp;Continue with Google</Text>
          </TouchableOpacity>

          
        </>
      )}
    </View>
  );
};

// ── Sidebar ───────────────────────────────────────────────────────────────────
const Sidebar = ({ current, onSelect, user, onUpload, onLogout, isLight, toggleTheme, onLoginRequest }) => {
  const isGuest = user?.isAnonymous || !user;
  
  // Script para traductor (solo web)
  useEffect(() => {
    if (Platform.OS === 'web' && !window.googleTranslateElementInit) {
      window.googleTranslateElementInit = () => {
        if (window.google?.translate?.TranslateElement) {
          new window.google.translate.TranslateElement({
            pageLanguage: 'en',
            includedLanguages: 'en,es,zh-CN,hi,fr,ar,bn,ru,pt,ur,id,de,ja,mr,te,tr,ta,zh-TW,vi,tl',
            layout: window.google.translate.TranslateElement.InlineLayout.SIMPLE
          }, 'google_translate_element');
        }
      };
      const script = document.createElement('script');
      script.src = '//translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';
      document.body.appendChild(script);
    }
  }, []);

  return (
    <View style={styles.sidebar}>
      <Text style={styles.sidebarTitle}>Topmeme</Text>
      <Text style={styles.sidebarUser} numberOfLines={1}>
        {user?.email ? `👤 ${user.email}` : '👻 Guest'}
      </Text>

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
          ⭐ PROMOTION
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        onPress={() => Linking.openURL('https://ko-fi.com/jijascuas')}
        style={[styles.menuItem, styles.donationMenuBtn]}
      >
        <Text style={[styles.menuText, { color: '#81C784', fontWeight: 'bold' }]}>
          ☕ Support / Donate
        </Text>
      </TouchableOpacity>

      <View style={styles.spacer} />

      <TouchableOpacity style={[styles.ruleBtn, isLight && { backgroundColor: '#f9f9f9', borderColor: '#ddd' }]}
        onPress={() => safeAlert('App Rules', '🤖 Artificial Intelligence rigorously reviews all images before publishing.\n\n❌ PROHIBITED:\n- Explicit content or nudity.\n- Violence, gore, or weapons.\n- Any illegal activity.\n\n📏 Size limit: 10 MB.\nFormat: JPG, PNG, GIF, WebP.')}>
        <Text style={[styles.ruleText, isLight && { color: '#555' }]}>📋 Rules</Text>
      </TouchableOpacity>

      {isGuest ? (
        <TouchableOpacity style={[styles.uploadBtn, { backgroundColor: '#1da1f2' }]} onPress={onLoginRequest}>
          <Text style={styles.uploadText}>Log in / Sign up</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity style={styles.uploadBtn} onPress={onUpload}>
          <Text style={styles.uploadText}>+ Upload meme</Text>
        </TouchableOpacity>
      )}

      {!isGuest && (
        <TouchableOpacity style={[styles.logoutBtn, isLight && { backgroundColor: '#ffe5e5', borderColor: '#ffcccc' }]} onPress={onLogout}>
          <Text style={styles.logoutText}>Log out</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity onPress={toggleTheme} style={[styles.logoutBtn, { marginTop: 12, backgroundColor: isLight ? '#f0f0f0' : '#222', borderColor: isLight ? '#ddd' : '#444' }]}>
        <Text style={{ color: isLight ? '#555' : '#aaa', fontSize: 13, fontWeight: 'bold' }}>
          {isLight ? '🌙 Dark Mode' : '☀️ Light Mode'}
        </Text>
      </TouchableOpacity>

      <View nativeID="google_translate_element" style={{ marginTop: 12, minHeight: 30, overflow: 'hidden', borderRadius: 6 }} />

      <TouchableOpacity onPress={() => Linking.openURL('https://topmeme-jijascuas.web.app/privacy.html')} style={{ marginTop: 20, alignItems: 'center' }}>
        <Text style={{ color: '#aaa', fontSize: 12, textDecorationLine: 'underline' }}>Privacy Policy</Text>
      </TouchableOpacity>
    </View>
  );
};

// ── Upload Modal ──────────────────────────────────────────────────────────────
const UploadModal = ({ visible, onClose, user, category }) => {
  const [imageUri, setImageUri]       = useState(null);
  const [imageBase64, setImageBase64] = useState(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [uploading, setUploading]     = useState(false);
  const [aiAnalyzing, setAiAnalyzing] = useState(false);
  const [paymentProcessing, setPaymentProcessing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [title, setTitle]             = useState('');
  const [giftCode, setGiftCode] = useState('');
  const [uploadError, setUploadError] = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (Platform.OS === 'android' && interstitial) {
      const unsubscribeLoaded = interstitial.addAdEventListener(AdEventType.LOADED, () => {});
      const unsubscribeClosed = interstitial.addAdEventListener(AdEventType.CLOSED, () => {
        interstitial.load(); // reload for next time
      });
      interstitial.load();
      return () => { unsubscribeLoaded(); unsubscribeClosed(); };
    }
  }, []);

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
    setTitle('');
    onClose();
  };

  const pickImage = async () => {
    setUploadError(null);
    setPreviewReady(false);
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') { safeAlert('Permiso denegado', 'Necesitamos acceso a tu galería.'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.8, // Bajar un poco la calidad para que el base64 no sea gigante
      base64: true, // Necesitamos base64 para la IA
    });
    if (!result.canceled) {
      setImageUri(result.assets[0].uri);
      setImageBase64(result.assets[0].base64);
    }
  };

  const uploadMeme = async (isGift = false) => {
    if (!imageUri || !imageBase64 || !previewReady) { safeAlert('Please Wait', 'Image is still pre-loading.'); return; }
    if (!title.trim()) { safeAlert('Error', 'Write a title for your meme.'); return; }
    
    setUploading(true);
    setUploadProgress(0);
    setUploadError(null);
    abortRef.current = new AbortController();
    
    try {
      setAiAnalyzing(true);
      const isSafe = await analyzeImageWithAI(imageBase64);
      setAiAnalyzing(false);

      if (!isSafe) {
        setUploading(false);
        setUploadError({
          title: '🚨 Image Rejected 🚨',
          reason: 'Our Artificial Intelligence has detected that this image violates our safety policies (violence, explicit or inappropriate content).',
          suggestion: 'Please select an image that follows the rules.'
        });
        return;
      }

      let requiresStripePayment = false;

      if (category === 'PROMOTION' || category === 'PROMOCION') {
        if (!isGift) {
          requiresStripePayment = true;
        } else {
          // GIFT CODE ROUTE
          const trimmedGift = giftCode.trim();
          if (!trimmedGift) {
            throw { title: 'Missing Code', reason: 'You must provide a gift code to use this option.', suggestion: 'Paste your 30-character code below.' };
          }
          setAiAnalyzing(true); 
          const giftsRef = collection(db, 'giftCodes');
          const qCode = query(giftsRef, where('code', '==', trimmedGift), where('used', '==', false), limit(1));
          const codeSnap = await getDocs(qCode);
          
          if (codeSnap.empty) {
             throw { title: 'Invalid Code', reason: 'The gift code is invalid or has already been used.', suggestion: 'Check the code or pay with card.' };
          }
          const codeDoc = codeSnap.docs[0];
          await updateDoc(codeDoc.ref, { used: true, usedBy: user.uid, usedAt: new Date() });
          setAiAnalyzing(false);
        }
      }

      const { url, bytes, publicId } = await uploadToCloudinary(
        imageUri, 
        abortRef.current.signal, 
        (p) => setUploadProgress(p)
      );

      const docRef = await addDoc(collection(db, 'memes'), {
        title: title.trim(), 
        category: (category === 'PROMOTION' || category === 'PROMOCION') ? 'PROMOTION' : 'general', 
        imageUrl: url,
        publicId, bytes,
        uploadedBy: user.uid, 
        uploaderEmail: user.email || 'guest',
        likes: 0, createdAt: new Date(),
        approved: !requiresStripePayment
      });

      if (Platform.OS === 'android' && interstitial && interstitial.loaded) {
        interstitial.show();
      }

      handleClose();

      const statsRef = doc(db, 'stats', 'storage');
      setDoc(statsRef, { totalBytes: increment(bytes || 0), totalMemes: increment(1), lastUpload: new Date() }, { merge: true }).catch(console.error);
      checkAndCleanupStorage().catch(console.error);

      if (requiresStripePayment) {
        if (Platform.OS === 'web') alert('Wait! Now you have to complete the 10$ payment.\n\nOpening secure Stripe Checkout...');
        Linking.openURL(`https://buy.stripe.com/14A8wI2kn9NJ43n25e1ZS00?client_reference_id=${docRef.id}`);
      }

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
            <Text style={styles.uploadModalTitle}>{category === 'PROMOTION' ? '⭐ Upload to PROMOTION' : 'Upload meme'}</Text>
            <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
              <Text style={styles.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.uploadModalSub}>
            {category === 'PROMOCION' 
              ? 'Destaca tu meme. Coste: 10$' 
              : `Participarás en el Ranking Global`}
          </Text>

          <TextInput
            style={styles.input} placeholder="Título del meme" placeholderTextColor="#666"
            value={title} onChangeText={setTitle} maxLength={80} editable={!uploading}
          />

          <TouchableOpacity style={styles.pickBtn} onPress={pickImage} disabled={uploading}>
            <Text style={styles.pickBtnText}>{imageUri ? '🖼️ Cambiar imagen' : '🖼️ Seleccionar imagen'}</Text>
          </TouchableOpacity>

          {/* Preview con indicador de precarga */}
          {imageUri && (
            <View style={styles.previewWrap}>
              <Image
                source={{ uri: imageUri }}
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
                  <Text style={{ color: '#aaa', marginTop: 6, fontSize: 12 }}>Cargando vista previa…</Text>
                </View>
              )}
              {previewReady && (
                <View style={styles.previewBadge}>
                  <Text style={styles.previewBadgeText}>✔ Lista para subir</Text>
                </View>
              )}
            </View>
          )}

          {/* Detailed Error Panel */}
          {uploadError && (
            <View style={styles.errorPanel}>
              <Text style={styles.errorPanelTitle}>❌ {uploadError.title}</Text>
              {uploadError.reason ? <><Text style={styles.errorPanelLabel}>Reason:</Text><Text style={styles.errorPanelText}>{uploadError.reason}</Text></> : null}
              {uploadError.suggestion ? <><Text style={styles.errorPanelLabel}>Suggestion:</Text><Text style={styles.errorPanelText}>{uploadError.suggestion}</Text></> : null}
              {uploadError.raw ? <Text style={styles.errorPanelRaw}>Technical: {uploadError.raw}</Text> : null}
            </View>
          )}

          {/* Botones y Barra de Progreso */}
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
                  {aiAnalyzing ? '🤖 AI Analyzing image...' 
                   : (paymentProcessing ? '💳 Processing $10 payment...' : `${Math.round(uploadProgress)}% uploading...`)}
                </Text>
              </View>
            )}

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity style={[styles.cancelBtn, uploading && !uploadError && { opacity: 0.5 }]} onPress={handleClose}>
                <Text style={styles.cancelBtnText}>{uploading && !uploadError ? 'Cancel' : 'Close'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.uploadBtn, 
                  { flex: 1 },
                  category === 'PROMOTION' && { backgroundColor: '#cca000' },
                  ((!previewReady || uploading) && !uploadError) && { opacity: 0.45 }
                ]}
                onPress={uploadMeme} disabled={(!previewReady || uploading) && !uploadError}
              >
                {(uploading && !uploadError)
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={styles.uploadText}>
                      {uploadError ? 'Retry' : (category === 'PROMOTION' ? '💳 Pay $10 and Upload' : 'Upload')}
                    </Text>
                }
              </TouchableOpacity>
            </View>
          </View>

        </View>
      </View>
    </Modal>
  );
};

// ── Meme Screen — feed estilo Instagram ──────────────────────────────────────
const MemeScreen = ({ category, user, isLight, onLoginRequest }) => {
  const [memes, setMemes]               = useState([]);
  const [loading, setLoading]           = useState(true);
  const [selectedMeme, setSelectedMeme] = useState(null);
  const [likingId, setLikingId]         = useState(null);

  useEffect(() => {
    setLoading(true);
    // Solicitamos los últimos 500 memes globales
    const q = query(collection(db, 'memes'), orderBy('createdAt', 'desc'), limit(500));
    const unsub = onSnapshot(q,
      snap => { 
        let allMemes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        let filtered = [];
        
        if (category === 'PROMOTION') {
           // Promocion simplemente coge los VIP, ordenados por fecha (ya vienen así)
           filtered = allMemes.filter(m => (m.category === 'PROMOTION' || m.category === 'PROMOCION') && m.approved !== false);
        } else if (category === 'My Memes') {
           // Mis Memes: Coge todos los que el usuario subió
           filtered = allMemes.filter(m => m.uploadedBy === user?.uid);
           filtered.sort((a, b) => b.createdAt - a.createdAt); // Orden descendiente
        } else {
           // Lógica competitiva: filtrar por antigüedad y ordenar por Likes
           let hoursAgo = 24;
           if (category === 'Week') hoursAgo = 24 * 7;
           if (category === 'Month')    hoursAgo = 24 * 30;
           if (category === 'Year')    hoursAgo = 24 * 365;
           
           const now = new Date();
           const cutoff = new Date(now.getTime() - (hoursAgo * 60 * 60 * 1000));

           filtered = allMemes.filter(m => {
             if (m.category === 'PROMOTION' || m.category === 'PROMOCION') return false; // Los VIP no salen en el global gratis
             if (m.approved === false) return false; // Hide unpaid ones
             const memeDate = m.createdAt?.toDate ? m.createdAt.toDate() : new Date(m.createdAt);
             return memeDate >= cutoff;
           });

           // Algoritmo: Mayor número de Likes va primero
           filtered.sort((a, b) => (b.likes || 0) - (a.likes || 0));
        }

        setMemes(filtered); 
        setLoading(false); 
      },
      err  => { console.error(err); setLoading(false); }
    );
    return () => unsub();
  }, [category, user]);

  const handleLike = async (meme) => {
    if (user?.isAnonymous || !user) {
      if (Platform.OS === 'web') alert('🔒 Members Only: Sign up or log in to vote.');
      else Alert.alert('🔒 Members Only', 'Sign up or log in to vote.');
      if (onLoginRequest) onLoginRequest();
      return;
    }
    if (likingId === meme.id) return; // Prevent local spamming

    const isLiked = meme.likedBy && meme.likedBy.includes(user.uid);
    
    // Check 1-minute wait for 'Unlike'
    if (isLiked) {
      if (meme.likeTimelock?.[user.uid]) {
        const timeElapsed = Date.now() - meme.likeTimelock[user.uid];
        if (timeElapsed < 60000) { // 1 minute in milliseconds
          const secondsLeft = Math.ceil((60000 - timeElapsed) / 1000);
          const msg = `🕒 Please wait ${secondsLeft} seconds before canceling your vote.`;
          if (Platform.OS === 'web') alert(msg);
          else Alert.alert('Too Fast', msg);
          return;
        }
      }
    }

    // Confirmation popups
    const title = isLiked ? 'Confirm' : 'Confirm';
    const msg = isLiked ? '¿Seguro que deseas quitar tu Me gusta?' : '¿Quieres darle Me gusta a este meme?';

    if (Platform.OS === 'web') {
      const confirmed = window.confirm(msg);
      if (!confirmed) return;
      executeToggleLike(meme, isLiked);
    } else {
      Alert.alert(title, msg, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Yes', style: isLiked ? 'destructive' : 'default', onPress: () => executeToggleLike(meme, isLiked) }
      ]);
    }
  };

  const executeToggleLike = async (meme, isLiked) => {
    setLikingId(meme.id);
    try {
      const memeRef = doc(db, 'memes', meme.id);
      
      await runTransaction(db, async (transaction) => {
        const memeDoc = await transaction.get(memeRef);
        if (!memeDoc.exists()) throw new Error('El meme ya no existe.');
        
        const data = memeDoc.data();
        const currentLikedBy = data.likedBy || [];
        const currentLikes = data.likes || 0;
        const timelocks = data.likeTimelock || {};

        if (!isLiked) {
          // Add Like
          if (currentLikedBy.includes(user.uid)) return; // Already liked natively
          currentLikedBy.push(user.uid);
          timelocks[user.uid] = Date.now(); // Record exact timestamp of the like

          transaction.update(memeRef, {
            likes: currentLikes + 1,
            likedBy: currentLikedBy,
            likeTimelock: timelocks
          });
        } else {
          // Remove Like
          if (!currentLikedBy.includes(user.uid)) return; // Already unliked
          const newLikedBy = currentLikedBy.filter(id => id !== user.uid);
          delete timelocks[user.uid]; // Clear their lock

          transaction.update(memeRef, {
            likes: Math.max(0, currentLikes - 1),
            likedBy: newLikedBy,
            likeTimelock: timelocks
          });
        }
      });
    } catch (e) {
      if (Platform.OS === 'web') alert(e.message);
      else Alert.alert('Error', e.message);
    }
    setLikingId(null);
  };

  const shareMeme = async (meme) => {
    const shareMessage = `🤣 Look at this Top Meme: "${meme.title}"\n${meme.imageUrl || meme.url}`;
    
    if (Platform.OS === 'web') {
       const text = encodeURIComponent(`🤣 Look at this Top Meme: "${meme.title}"\n`);
       const link = encodeURIComponent(meme.imageUrl || meme.url);
       const intentUrl = `https://twitter.com/intent/tweet?text=${text}&url=${link}`;
       window.open(intentUrl, '_blank');
    } else {
      try {
        await Share.share({
          message: shareMessage,
          url: meme.imageUrl || meme.url, // Solo para iOS
          title: 'Share Topmeme'
        });
      } catch (error) {
        safeAlert('Error', error.message);
      }
    }
  };

  const deleteMeme = async (meme) => {
    if (user?.uid !== meme.uploadedBy) return;
    
    if (Platform.OS === 'web') {
      const confirmed = window.confirm('Erase Meme: Are you sure you want to permanently delete this meme?');
      if (confirmed) {
         try {
           await deleteDoc(doc(db, 'memes', meme.id));
           setSelectedMeme(null);
           alert('Meme deleted successfully!');
         } catch (e) { alert(e.message); }
      }
      return;
    }

    Alert.alert('Erase Meme', 'Are you sure you want to permanently delete this meme?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
         try {
           await deleteDoc(doc(db, 'memes', meme.id));
           setSelectedMeme(null);
           Alert.alert('Success', 'Meme deleted successfully!');
         } catch (e) { Alert.alert('Error', e.message); }
      }}
    ]);
  };

  if (loading) return (
    <View style={[styles.content, { justifyContent: 'center', alignItems: 'center' }, isLight && { backgroundColor: '#f5f5f5' }]}>
      <ActivityIndicator color="#3897f0" size="large" />
      <Text style={{ color: isLight ? '#888' : '#aaa', marginTop: 12 }}>Loading memes…</Text>
    </View>
  );

  if (memes.length === 0) return (
    <View style={[styles.content, { justifyContent: 'center', alignItems: 'center' }, isLight && { backgroundColor: '#f5f5f5' }]}>
      <Text style={[styles.emptyText, isLight && { color: '#666' }]}>
        {category === 'PROMOTION' ? '⭐ No promotions yet' : (category === 'My Memes' ? '🗂️ No memes found' : '🏜️ No memes in this top')}
      </Text>
      <Text style={{ color: isLight ? '#888' : '#555', marginTop: 8 }}>
        {category === 'PROMOTION' ? 'Be the first to stand out for $10!' : (category === 'My Memes' ? 'You have not uploaded any meme yet.' : 'Be the first to upload and win!')}
      </Text>
    </View>
  );

  const renderItem = ({ item: m }) => (
    <TouchableOpacity style={[styles.gridCell, isLight && { backgroundColor: '#fff', borderColor: '#e0e0e0' }]} onPress={() => setSelectedMeme(m)}>
      <Image source={{ uri: m.imageUrl || m.url }} style={styles.gridThumb} resizeMode="cover" />
      {(m.category === 'PROMOTION' || m.category === 'PROMOCION') && (
        <View style={styles.vipBadgeSmall}><Text style={styles.vipBadgeTextSmall}>⭐ VIP</Text></View>
      )}
      <View style={[styles.gridLikesBadge, isLight && { backgroundColor: 'rgba(255,255,255,0.85)' }]}>
        <Text style={[styles.gridLikesText, isLight && { color: '#000' }]}>{m.likedBy?.includes(user?.uid) ? '❤️' : '🤍'} {m.likes || 0}</Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={[styles.content, isLight && { backgroundColor: '#f0f2f5' }]}>
      <Text style={[styles.headerTitle, isLight && { color: '#111' }, category === 'PROMOTION' && { color: '#ffd700' }]}>
        {category === 'PROMOTION' ? '⭐ PROMOTION' : (category === 'My Memes' ? '👤 My Memes' : `🏆 Top Memes of the ${category}`)}
      </Text>
      <Text style={[styles.disclaimerText, isLight && { color: '#666' }]}>
        ⚠️ Topmeme is not responsible for the content uploaded by users.
      </Text>

      {/* Grid */}
      <FlatList 
        data={memes} 
        keyExtractor={m => m.id} 
        numColumns={3}
        columnWrapperStyle={styles.gridRow}
        renderItem={renderItem}
      />

      {/* Detail Modal */}
      <Modal visible={!!selectedMeme} transparent animationType="fade" onRequestClose={() => setSelectedMeme(null)}>
        <View style={styles.detailOverlay}>
          {selectedMeme && (
            <>
              <TouchableOpacity style={styles.detailClose} onPress={() => setSelectedMeme(null)}>
                <Text style={styles.detailCloseText}>×</Text>
              </TouchableOpacity>
              
              <Image source={{ uri: selectedMeme.imageUrl || selectedMeme.url }} style={styles.detailImage} resizeMode="contain" />
              
              <View style={styles.detailMeta}>
                <Text style={styles.detailTitle}>{selectedMeme.title}</Text>
                {selectedMeme.uploaderEmail && <Text style={styles.detailAuthor}>By: {selectedMeme.uploaderEmail}</Text>}
                
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <TouchableOpacity 
                     style={[styles.detailLikeBtn, selectedMeme.likedBy?.includes(user?.uid) && { borderColor: '#ff4d6d' }]} 
                     onPress={() => handleLike(selectedMeme)}
                  >
                    <Text style={styles.detailLikeText}>
                      {selectedMeme.likedBy?.includes(user?.uid) ? '❤️ Cancelar' : '🤍 Me gusta'}
                    </Text>
                  </TouchableOpacity>
                  
                  <TouchableOpacity 
                     style={[styles.detailLikeBtn, { borderColor: '#1da1f2' }]} 
                     onPress={() => shareMeme(selectedMeme)}
                  >
                    <Text style={[styles.detailLikeText, { color: '#1da1f2' }]}>🐦 Share on X</Text>
                  </TouchableOpacity>
                </View>

                {user && user.uid === selectedMeme.uploadedBy && (
                  <TouchableOpacity style={[styles.detailLikeBtn, { marginTop: 12, borderColor: '#f44', backgroundColor: '#311' }]} onPress={() => deleteMeme(selectedMeme)}>
                    <Text style={[styles.detailLikeText, { color: '#f44', fontSize: 13 }]}>🗑️ Delete Meme</Text>
                  </TouchableOpacity>
                )}
              </View>
            </>
          )}
        </View>
      </Modal>
    </View>
  );
};

// ── END OF FILE

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [user, setUser]                   = useState(null);
  const [authLoading, setAuthLoading]     = useState(true);
  const [currentCategory, setCurrentCategory] = useState('Day');
  const [showUpload, setShowUpload]       = useState(false);
  const [isLight, setIsLight]             = useState(false);
  const [showAuth, setShowAuth]           = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, u => { setUser(u); setAuthLoading(false); });
    return unsub;
  }, []);

  const handleLogout = async () => { await signOut(auth); };

  if (authLoading) return (
    <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
      <ActivityIndicator color="#3897f0" size="large" />
      <Text style={{ color: '#aaa', marginTop: 12 }}>Loading Topmeme…</Text>
    </View>
  );

  if (!user && showAuth) return <AuthScreen onClose={() => setShowAuth(false)} />;

  return (
    <SafeAreaView style={[styles.container, isLight && { backgroundColor: '#f0f2f5' }]}>
      <View style={styles.appContainer}>
        <Sidebar
          current={currentCategory}
          onSelect={setCurrentCategory}
          user={user}
          onUpload={() => setShowUpload(true)}
          onLogout={handleLogout}
          isLight={isLight}
          toggleTheme={() => setIsLight(!isLight)}
          onLoginRequest={() => setShowAuth(true)}
        />
        <MemeScreen category={currentCategory} user={user} isLight={isLight} onLoginRequest={() => setShowAuth(true)} />
      </View>

      {Platform.OS === 'android' && bannerAdUnitId && (
        <View style={{ alignItems: 'center', backgroundColor: isLight ? '#f0f2f5' : '#111' }}>
          <BannerAd
            unitId={bannerAdUnitId}
            size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
            requestOptions={{ requestNonPersonalizedAdsOnly: true }}
          />
        </View>
      )}

      <UploadModal
        visible={showUpload}
        onClose={() => setShowUpload(false)}
        user={user}
        category={currentCategory}
      />
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  // Layout
  container:    { flex: 1, backgroundColor: '#000' },
  appContainer: { flex: 1, flexDirection: 'row' },

  // Auth
  authContainer: { flex: 1, backgroundColor: '#0a0a0a', justifyContent: 'center', alignItems: 'center', padding: 30 },
  authLogo:      { fontSize: 42, fontWeight: 'bold', color: '#fff', marginBottom: 8 },
  authSubtitle:  { fontSize: 18, color: '#aaa', marginBottom: 30 },
  input:         { width: '100%', maxWidth: 360, backgroundColor: '#1a1a1a', color: '#fff', padding: 14, borderRadius: 12, marginBottom: 12, fontSize: 16, borderWidth: 1, borderColor: '#333' },
  authBtn:       { width: '100%', maxWidth: 360, backgroundColor: '#3897f0', padding: 16, borderRadius: 12, alignItems: 'center', marginTop: 4 },
  authBtnText:   { color: '#fff', fontWeight: 'bold', fontSize: 17 },
  switchText:    { color: '#3897f0', fontSize: 14, marginTop: 4 },
  divider:       { flexDirection: 'row', alignItems: 'center', width: '100%', maxWidth: 360, marginVertical: 20 },
  dividerLine:   { flex: 1, height: 1, backgroundColor: '#333' },
  dividerText:   { color: '#555', marginHorizontal: 12, fontSize: 14 },
  anonBtn:       { width: '100%', maxWidth: 360, backgroundColor: '#222', padding: 16, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: '#444' },
  anonBtnText:   { color: '#aaa', fontWeight: '600', fontSize: 16 },
  googleBtn:     { width: '100%', maxWidth: 360, backgroundColor: '#fff', padding: 16, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: '#ddd' },
  googleBtnText: { color: '#222', fontWeight: '700', fontSize: 16 },

  // Sidebar
  sidebar:        { width: 220, backgroundColor: '#111', padding: 20, borderRightWidth: 1, borderColor: '#222' },
  sidebarTitle:   { fontSize: 22, fontWeight: 'bold', color: '#fff', marginBottom: 4 },
  sidebarUser:    { fontSize: 12, color: '#555', marginBottom: 28 },
  menuItem:       { paddingVertical: 13, paddingHorizontal: 10, borderRadius: 10, marginBottom: 4 },
  activeMenuItem: { backgroundColor: '#1e1e1e' },
  promoMenuBtn:   { marginTop: 12, backgroundColor: '#141400', borderWidth: 1, borderColor: '#554400' },
  donationMenuBtn: { marginTop: 8, backgroundColor: '#1b3a20', borderWidth: 1, borderColor: '#4CAF50' },
  menuText:       { fontSize: 15, color: '#777', fontWeight: '500' },
  activeMenuText: { color: '#fff' },
  spacer:         { flex: 1 },
  ruleBtn:        { backgroundColor: '#1a1a1a', padding: 12, borderRadius: 10, alignItems: 'center', marginBottom: 8, borderWidth: 1, borderColor: '#333' },
  ruleText:       { color: '#aaa', fontSize: 14 },
  uploadBtn:      { backgroundColor: '#3897f0', padding: 14, borderRadius: 10, alignItems: 'center' },
  uploadText:     { color: '#fff', fontWeight: 'bold', fontSize: 15 },
  logoutBtn:      { backgroundColor: '#200000', padding: 12, borderRadius: 10, alignItems: 'center', marginTop: 8, borderWidth: 1, borderColor: '#500' },
  logoutText:     { color: '#f44', fontSize: 14 },
  guestBanner:    { backgroundColor: '#1a1a0a', borderWidth: 1, borderColor: '#443300', borderRadius: 10, padding: 12, alignItems: 'center' },
  guestBannerText:{ color: '#aa8800', fontSize: 13, fontWeight: '700' },
  guestBannerSub: { color: '#665500', fontSize: 11, marginTop: 4, textAlign: 'center' },

  // Feed — Grid Instagram
  content:     { flex: 1, padding: 16, backgroundColor: '#000' },
  headerTitle: { fontSize: 22, fontWeight: 'bold', color: '#fff', marginBottom: 4 },
  disclaimerText:{ fontSize: 11, color: '#aaa', fontStyle: 'italic', marginBottom: 12 },
  emptyText:   { fontSize: 28, color: '#333', textAlign: 'center' },
  gridRow:     { gap: 8, marginBottom: 8, justifyContent: 'flex-start' },
  gridCell:    { flex: 1/3, maxWidth: '33%', aspectRatio: 1, position: 'relative', overflow: 'hidden', borderRadius: 8, backgroundColor: '#111', borderWidth: 1, borderColor: '#222' },
  gridThumb:   { width: '100%', height: '100%' },
  gridLikesBadge: { position: 'absolute', top: 6, right: 6, backgroundColor: 'rgba(0,0,0,0.7)', paddingHorizontal: 6, paddingVertical: 4, borderRadius: 12 },
  gridLikesText:  { color: '#fff', fontSize: 11, fontWeight: '700' },
  vipBadgeSmall: { position: 'absolute', top: 6, left: 6, backgroundColor: 'rgba(255,215,0,0.9)', paddingHorizontal: 4, paddingVertical: 2, borderRadius: 6 },
  vipBadgeTextSmall: { fontSize: 9, color: '#000', fontWeight: 'bold' },

  // Detail modal (vista completa al pinchar)
  detailOverlay:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center', alignItems: 'center' },
  detailClose:     { position: 'absolute', top: 20, right: 20, padding: 10, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 20 },
  detailCloseText: { color: '#fff', fontSize: 20, fontWeight: 'bold' },
  detailImage:     { width: '90%', height: '65%' },
  detailMeta:      { marginTop: 16, alignItems: 'center' },
  detailTitle:     { color: '#fff', fontSize: 20, fontWeight: 'bold', textAlign: 'center', marginBottom: 4 },
  detailAuthor:    { color: '#666', fontSize: 13, marginBottom: 12 },
  detailLikeBtn:   { backgroundColor: '#1a1a1a', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 24, borderWidth: 1, borderColor: '#333' },
  detailLikeText:  { color: '#81C784', fontSize: 16, fontWeight: '700' },

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
  cancelBtn:       { flex: 1, backgroundColor: '#1a1a1a', padding: 14, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: '#333' },
  cancelBtnText:   { color: '#aaa', fontSize: 15 },
  closeBtn:        { padding: 6 },
  closeBtnText:    { color: '#aaa', fontSize: 20, fontWeight: 'bold' },

  // Error panel
  errorPanel:      { backgroundColor: '#1a0509', borderWidth: 1, borderColor: '#5a1020', borderRadius: 12, padding: 14, marginTop: 14 },
  errorPanelTitle: { color: '#81C784', fontWeight: 'bold', fontSize: 15, marginBottom: 8 },
  errorPanelLabel: { color: '#aa3344', fontSize: 11, fontWeight: '700', textTransform: 'uppercase', marginTop: 6, marginBottom: 2 },
  errorPanelText:  { color: '#dda0aa', fontSize: 13 },
  errorPanelRaw:   { color: '#664455', fontSize: 10, marginTop: 8, fontStyle: 'italic' },

  // Progress Bar
  progressBarWrap: { width: '100%', height: 24, backgroundColor: '#1a1a1a', borderRadius: 12, overflow: 'hidden', marginBottom: 12, justifyContent: 'center', borderWidth: 1, borderColor: '#333' },
  progressBar:     { height: '100%', backgroundColor: '#3897f0' },
  progressText:    { position: 'absolute', width: '100%', textAlign: 'center', color: '#fff', fontSize: 11, fontWeight: 'bold' },
});
