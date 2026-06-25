// firebase-init.js
// Auto-generated for Firebase project: dailyflow-9a13e

import { initializeApp }           from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth,
         GoogleAuthProvider,
         RecaptchaVerifier,
         signInWithPopup,
         signInWithEmailAndPassword,
         createUserWithEmailAndPassword,
         signInWithPhoneNumber,
         sendPasswordResetEmail,
         signOut,
         onAuthStateChanged }       from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore,
         doc, getDoc, setDoc }      from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey:            "AIzaSyBHq5AnhuyNIl5WCz9VOUx8VZ7wzqtPG7w",
  authDomain:        "dailyflow-9a13e.firebaseapp.com",
  projectId:         "dailyflow-9a13e",
  storageBucket:     "dailyflow-9a13e.firebasestorage.app",
  messagingSenderId: "865246278947",
  appId:             "1:865246278947:web:286aa6959da64d11f38896",
  measurementId:     "G-GRM5HYZ9S0"
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// ── Expose to app.js via window (module isolation bridge) ──
window._df_auth   = auth;
window._df_db     = db;

// Auth methods
window._df_signInGoogle        = () => signInWithPopup(auth, new GoogleAuthProvider());
window._df_signInEmail         = (email, pass) => signInWithEmailAndPassword(auth, email, pass);
window._df_signUpEmail         = (email, pass) => createUserWithEmailAndPassword(auth, email, pass);
window._df_sendPasswordReset   = (email) => sendPasswordResetEmail(auth, email);
window._df_signInPhone         = (phone, verifier) => signInWithPhoneNumber(auth, phone, verifier);
window._df_signOut             = () => signOut(auth);
window._df_onAuthStateChanged  = (cb) => onAuthStateChanged(auth, cb);

// Firestore helpers
window._df_getDoc = getDoc;
window._df_setDoc = setDoc;
window._df_doc    = doc;

// RecaptchaVerifier factory (phone auth)
window._df_RecaptchaVerifier = (containerId, params) =>
  new RecaptchaVerifier(auth, containerId, params);

console.log("[DailyFlow] Firebase ready — project:", firebaseConfig.projectId);
