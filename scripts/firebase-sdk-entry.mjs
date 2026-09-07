// Only the SDK surface used by firebase-init.js is bundled into the offline shell.
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithPopup, GoogleAuthProvider,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail,
  signInWithPhoneNumber, signOut, onAuthStateChanged, RecaptchaVerifier } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc,
  getDocs, collection, onSnapshot, runTransaction } from 'firebase/firestore';

export const appSdk = { initializeApp };
export const authSdk = { getAuth, connectAuthEmulator, signInWithPopup, GoogleAuthProvider,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail,
  signInWithPhoneNumber, signOut, onAuthStateChanged, RecaptchaVerifier };
export const fsSdk = { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc,
  getDocs, collection, onSnapshot, runTransaction };
