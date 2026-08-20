import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyCSNTpTY3cmhRWqWB7mD4rLEzXAwPF9cgA",
  authDomain: "allaktivitetshuset-9145b.firebaseapp.com",
  projectId: "allaktivitetshuset-9145b",
  storageBucket: "allaktivitetshuset-9145b.firebasestorage.app",
  messagingSenderId: "904212153092",
  appId: "1:904212153092:web:13959d365d48534a22c651"
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);
