// Local previews never connect to production unless explicitly requested.
const params = new URLSearchParams(location.search);
const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) || location.protocol === 'file:';
const mode = params.get('firebase') || (localHost ? 'local' : 'production');
window._df_localMode = mode === 'local';
if (mode !== 'local') {
  try {
    const {appSdk, authSdk, fsSdk} = await import('./vendor/firebase-sdk.js');
    const app = appSdk.initializeApp({
      apiKey: 'AIzaSyBHq5AnhuyNIl5WCz9VOUx8VZ7wzqtPG7w',
      authDomain: 'dailyflow-9a13e.firebaseapp.com',
      projectId: mode === 'emulator' ? 'demo-dailyflow' : 'dailyflow-9a13e',
      storageBucket: 'dailyflow-9a13e.firebasestorage.app',
      messagingSenderId: '865246278947',
      appId: '1:865246278947:web:286aa6959da64d11f38896'
    });
    const auth = authSdk.getAuth(app);
    const db = fsSdk.getFirestore(app);
    if (mode === 'emulator') {
      authSdk.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      fsSdk.connectFirestoreEmulator(db, '127.0.0.1', 8080);
    }
    Object.assign(window, {
      _df_auth: auth, _df_db: db, _df_doc: fsSdk.doc,
      _df_getDoc: fsSdk.getDoc, _df_setDoc: fsSdk.setDoc,
      _df_getDocs: fsSdk.getDocs, _df_collection: fsSdk.collection,
      _df_onSnapshot: fsSdk.onSnapshot, _df_runTransaction: fsSdk.runTransaction,
      _df_signInGoogle: () => authSdk.signInWithPopup(auth, new authSdk.GoogleAuthProvider()),
      _df_signInEmail: (email, pass) => authSdk.signInWithEmailAndPassword(auth, email, pass),
      _df_signUpEmail: (email, pass) => authSdk.createUserWithEmailAndPassword(auth, email, pass),
      _df_sendPasswordReset: email => authSdk.sendPasswordResetEmail(auth, email),
      _df_signInPhone: (phone, verifier) => authSdk.signInWithPhoneNumber(auth, phone, verifier),
      _df_signOut: () => authSdk.signOut(auth),
      _df_onAuthStateChanged: callback => authSdk.onAuthStateChanged(auth, callback),
      _df_RecaptchaVerifier: (container, options) => new authSdk.RecaptchaVerifier(auth, container, options)
    });
  } catch (error) {
    window._df_firebaseError = 'Cloud sign-in could not load. Check your connection and reload.';
    console.error('Firebase initialization failed:', error.code || error.message);
  }
}
window._df_firebaseReady = true;
window.dispatchEvent(new Event('dailyflow-firebase-ready'));
