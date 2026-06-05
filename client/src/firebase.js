import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

// Firebase client config is intentionally public — safe to have in source code.
// See: https://firebase.google.com/docs/projects/api-keys
const firebaseConfig = {
  apiKey:            "AIzaSyAvlbR82lKSicijD5CZY50ohgv0zhLaMuQ",
  authDomain:        "leadforge-leads-2026.firebaseapp.com",
  projectId:         "leadforge-leads-2026",
  storageBucket:     "leadforge-leads-2026.firebasestorage.app",
  messagingSenderId: "227757291697",
  appId:             "1:227757291697:web:c7fa9f44f67ca9b0938a90",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
