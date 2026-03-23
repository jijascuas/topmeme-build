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
 */
const getBlobForUpload = async (imageUri) => {
  if (typeof document !== 'undefined') {
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
  const resp = await fetch(imageUri);
  if (!resp.ok) throw new Error('No se pudo leer el archivo local');
  return resp.blob();
};

/** Sube imagen a Cloudinary. */
const uploadToCloudinary = (imageUri, signal, onProgress) => {
  return new Promise(async (resolve, reject) => {
    let blob;
    try {
      blob = await getBlobForUpload(imageUri);
    } catch (e) {
      return reject({ title: 'Error al procesar la imagen', reason: e.message, suggestion: 'Prueba con otra imagen.' });
    }

    if (blob.size > CLOUDINARY_MAX_FILE_BYTES) {
      return reject({
        title: 'Imagen demasiado grande',
        reason: `El archivo pesa ${(blob.size / 1024 / 1024).toFixed(1)} MB. Límite 10 MB.`,
        suggestion: 'Usa una imagen más pequeña.',
      });
    }

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

/** Auto-limpieza de almacenamiento. */
const checkAndCleanupStorage = async () => {
  try {
    const statsRef = doc(db, 'stats', 'storage');
    const snap = await getDoc(statsRef);
    const total = snap.exists() ? (snap.data().totalBytes || 0) : 0;
    if (total < CLEANUP_THRESHOLD) return;
    const q = query(collection(db, 'memes'), orderBy('createdAt', 'asc'), limit(CLEANUP_BATCH));
    const oldSnap = await getDocs(q);
    let freed = 0;
    for (const d of oldSnap.docs) { freed += d.data().bytes || 0; await deleteDoc(d.ref); }
    await updateDoc(statsRef, { totalBytes: Math.max(0, total - freed), lastCleanup: new Date(), cleanedMemes: increment(CLEANUP_BATCH) });
  } catch (e) { console.error('Limpieza automática:', e); }
};

/** Analiza la imagen usando Google Cloud Vision API. */
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
    if (!response.ok) throw new Error(`Error de visión API: ${response.status}`);
    const data = await response.json();
    const safeSearch = data.responses[0]?.safeSearchAnnotation;
    if (!safeSearch) return true;
    const isUnsafe = (val) => val === 'LIKELY' || val === 'VERY_LIKELY' || val === 'POSSIBLE';
    if (isUnsafe(safeSearch.adult) || isUnsafe(safeSearch.violence) || isUnsafe(safeSearch.racy)) return false;
    return true;
  } catch (e) {
    console.warn('AI Analysis Skipped:', e.message);
    return true;
  }
};

const categories = ['Day', 'Week', 'Month', 'Year', 'My Memes'];

const safeAlert = (title, message) => {
  if (Platform.OS === 'web') window.alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
};

// ── Authentication ──────────────────────────────────────────────────────────
const AuthScreen = ({ onClose }) => {
  const [email, setEmail]         = useState('');
  const [password, setPassword]   = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [loading, setLoading]     = useState(false);

  const handleEmailAuth = async () => {
    if (!email || !password) { safeAlert('Error', 'Enter status and password.'); return; }
    setLoading(true);
    try {
      if (isRegister) await createUserWithEmailAndPassword(auth, email, password);
      else            await signInWithEmailAndPassword(auth, email, password);
    } catch (e) { safeAlert('Error', e.message); }
    setLoading(false);
  };

  const handleGoogle = async () => {
    setLoading(true);
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (e) { if (e.code !== 'auth/popup-closed-by-user') safeAlert('Error', e.message); }
    setLoading(false);
  };

  return (
    <View style={styles.authContainer}>
      <Text style={styles.authLogo}>🔥 Topmeme</Text>
      <Text style={styles.authSubtitle}>{isRegister ? 'Create an account' : 'Log in'}</Text>
      <TextInput style={styles.input} placeholder="Email" placeholderTextColor="#666" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
      <TextInput style={styles.input} placeholder="Password" placeholderTextColor="#666" value={password} onChangeText={setPassword} secureTextEntry />
      {loading ? <ActivityIndicator color="#3897f0" size="large" /> : (
        <>
          <TouchableOpacity style={styles.authBtn} onPress={handleEmailAuth}>
            <Text style={styles.authBtnText}>{isRegister ? 'Sign Up' : 'Log In'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setIsRegister(!isRegister)}>
            <Text style={styles.switchText}>{isRegister ? 'Already have an account? Log in' : "Don't have an account? Sign up"}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.googleBtn} onPress={handleGoogle}>
            <Text style={styles.googleBtnText}>🇬 Continue with Google</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
};

// ── Components ──────────────────────────────────────────────────────────────
const Sidebar = ({ current, onSelect, user, onUpload, onLogout, isLight, toggleTheme, onLoginRequest }) => {
  const isGuest = user?.isAnonymous || !user;
  return (
    <View style={styles.sidebar}>
      <Text style={styles.sidebarTitle}>Topmeme</Text>
      <Text style={styles.sidebarUser}>{user?.email ? `👤 ${user.email}` : '👻 Guest'}</Text>
      {categories.map(cat => (
        <TouchableOpacity key={cat} onPress={() => onSelect(cat)} style={[styles.menuItem, current === cat && styles.activeMenuItem]}>
          <Text style={[styles.menuText, current === cat && styles.activeMenuText]}>{cat === 'My Memes' ? 'My Memes' : `Meme of the ${cat}`}</Text>
        </TouchableOpacity>
      ))}
      <TouchableOpacity onPress={() => onSelect('PROMOTION')} style={[styles.menuItem, current === 'PROMOTION' && styles.activeMenuItem, styles.promoMenuBtn]}>
        <Text style={[styles.menuText, { color: '#ffd700', fontWeight: 'bold' }]}>⭐ PROMOTION</Text>
      </TouchableOpacity>
      <View style={styles.spacer} />
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
        <TouchableOpacity style={styles.logoutBtn} onPress={onLogout}>
          <Text style={styles.logoutText}>Log out</Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity onPress={toggleTheme} style={styles.logoutBtn}>
        <Text style={{ color: '#aaa' }}>{isLight ? '🌙 Dark Mode' : '☀️ Light Mode'}</Text>
      </TouchableOpacity>
    </View>
  );
};

const UploadModal = ({ visible, onClose, user, category }) => {
  const [imageUri, setImageUri]       = useState(null);
  const [imageBase64, setImageBase64] = useState(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [uploading, setUploading]     = useState(false);
  const [title, setTitle]             = useState('');
  const [uploadError, setUploadError] = useState(null);
  const abortRef = useRef(null);

  const pickImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: false, quality: 0.8, base64: true });
    if (!result.canceled) { setImageUri(result.assets[0].uri); setImageBase64(result.assets[0].base64); }
  };

  const uploadMeme = async () => {
    if (!imageUri || !title) return;
    setUploading(true);
    setUploadError(null);
    abortRef.current = new AbortController();
    try {
      const isSafe = await analyzeImageWithAI(imageBase64);
      if (!isSafe) throw new Error('Contenido inapropiado detectado.');
      
      const isPromotion = category === 'PROMOTION';
      const { url, bytes, publicId } = await uploadToCloudinary(imageUri, abortRef.current.signal);
      
      const docRef = await addDoc(collection(db, 'memes'), {
        title: title.trim(), 
        category: isPromotion ? 'PROMOTION' : 'general', 
        imageUrl: url,
        publicId, bytes,
        uploadedBy: user.uid, 
        uploaderEmail: user.email || 'guest',
        likes: 0, 
        createdAt: new Date(),
        approved: !isPromotion // False for promotion until payment
      });

      if (isPromotion) {
         Linking.openURL(`https://buy.stripe.com/14A8wI2kn9NJ43n25e1ZS00?client_reference_id=${docRef.id}`);
         safeAlert('Promoción', 'Meme subido. Esperando pago para activarlo en el ranking.');
      } else {
         safeAlert('Éxito', 'Meme subido correctamente.');
      }
      onClose();
    } catch (e) { setUploadError(e.message); }
    setUploading(false);
  };

  return (
    <Modal visible={visible} transparent>
      <View style={styles.modalOverlay}>
        <View style={styles.uploadModal}>
          <Text style={styles.uploadModalTitle}>Upload Meme</Text>
          <TextInput style={styles.input} placeholder="Title" value={title} onChangeText={setTitle} />
          <TouchableOpacity style={styles.pickBtn} onPress={pickImage}><Text>🖼️ Seleccionar</Text></TouchableOpacity>
          {uploadError && <Text style={{ color: 'red' }}>{uploadError}</Text>}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
            <TouchableOpacity onPress={onClose}><Text>Cerrar</Text></TouchableOpacity>
            <TouchableOpacity onPress={uploadMeme} disabled={uploading}>
              <Text>{category === 'PROMOTION' ? '💳 Pay $10 & Upload' : 'Upload'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const MemeScreen = ({ category, user, isLight, onLoginRequest }) => {
  const [memes, setMemes] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, 'memes'), orderBy('createdAt', 'desc'), limit(50));
    return onSnapshot(q, snap => {
      let data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      
      if (category === 'PROMOTION') {
        data = data.filter(m => (m.category === 'PROMOTION' || m.category === 'PROMOCION') && m.approved === true);
      } else if (category === 'My Memes') {
        data = data.filter(m => m.uploadedBy === user?.uid);
      } else {
        data = data.filter(m => m.category !== 'PROMOTION' && m.category !== 'PROMOCION' && m.approved !== false);
      }
      
      setMemes(data);
      setLoading(false);
    });
  }, [category]);

  const handleLike = async (meme) => {
    if (!user) return onLoginRequest();
    const memeRef = doc(db, 'memes', meme.id);
    await updateDoc(memeRef, { likes: increment(1) });
  };

  return (
    <FlatList
      data={memes}
      keyExtractor={item => item.id}
      renderItem={({ item }) => (
        <View style={styles.memeCard}>
          <Text style={styles.memeTitle}>{item.title}</Text>
          <Image source={{ uri: item.imageUrl }} style={styles.memeImage} />
          <TouchableOpacity onPress={() => handleLike(item)}>
            <Text style={styles.likeText}>❤️ {item.likes}</Text>
          </TouchableOpacity>
        </View>
      )}
    />
  );
};

// ── Main App ────────────────────────────────────────────────────────────────
export default function App() {
  const [user, setUser] = useState(null);
  const [category, setCategory] = useState('Day');
  const [uploadVisible, setUploadVisible] = useState(false);
  const [isLight, setIsLight] = useState(false);
  const [showAuth, setShowAuth] = useState(false);

  useEffect(() => { return onAuthStateChanged(auth, u => { setUser(u); if (u) setShowAuth(false); else setShowAuth(true); }); }, []);

  if (showAuth && !user) return <AuthScreen onClose={() => setShowAuth(false)} />;

  return (
    <SafeAreaView style={[styles.container, isLight && styles.lightContainer]}>
      <Sidebar 
        current={category} user={user} 
        onSelect={setCategory} onUpload={() => setUploadVisible(true)} 
        onLogout={() => signOut(auth)} isLight={isLight} toggleTheme={() => setIsLight(!isLight)}
        onLoginRequest={() => setShowAuth(true)}
      />
      <View style={styles.content}>
        <MemeScreen category={category} user={user} isLight={isLight} onLoginRequest={() => setShowAuth(true)} />
      </View>
      <UploadModal visible={uploadVisible} onClose={() => setUploadVisible(false)} user={user} category={category} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, flexDirection: 'row', backgroundColor: '#000' },
  lightContainer: { backgroundColor: '#fff' },
  sidebar: { width: 250, padding: 20, borderRightWidth: 1, borderColor: '#333' },
  sidebarTitle: { color: '#fff', fontSize: 24, fontWeight: 'bold' },
  sidebarUser: { color: '#aaa', marginVertical: 10 },
  menuItem: { padding: 10, marginVertical: 5 },
  activeMenuItem: { backgroundColor: '#1da1f2', borderRadius: 5 },
  menuText: { color: '#fff' },
  activeMenuText: { fontWeight: 'bold' },
  uploadBtn: { backgroundColor: '#3897f0', padding: 15, borderRadius: 10, alignItems: 'center' },
  uploadText: { color: '#fff', fontWeight: 'bold' },
  content: { flex: 1, padding: 10 },
  memeCard: { backgroundColor: '#111', marginVertical: 10, borderRadius: 10, overflow: 'hidden' },
  memeTitle: { color: '#fff', padding: 10, fontSize: 18 },
  memeImage: { width: '100%', height: 400, resizeMode: 'contain' },
  likeText: { color: '#fff', padding: 10 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'center', alignItems: 'center' },
  uploadModal: { backgroundColor: '#fff', padding: 20, borderRadius: 10, width: '80%' },
  input: { borderBottomWidth: 1, borderColor: '#ccc', marginVertical: 10, padding: 5 },
  authContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  authLogo: { color: '#fff', fontSize: 32, fontWeight: 'bold' },
  authSubtitle: { color: '#aaa', marginVertical: 10 },
  authBtn: { backgroundColor: '#3897f0', padding: 15, borderRadius: 5, width: '80%', alignItems: 'center' },
  googleBtn: { backgroundColor: '#444', padding: 10, borderRadius: 5, marginTop: 10, width: '80%', alignItems: 'center' },
  switchText: { color: '#3897f0', marginTop: 10 },
  spacer: { flex: 1 },
  promoMenuBtn: { borderColor: '#ffd700', borderWidth: 1 }
});
