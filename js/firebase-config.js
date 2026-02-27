import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-storage.js";

// Central Firebase project configuration used by all frontend modules.
const firebaseConfig = {
  apiKey: "REMOVED_SECRET",
  authDomain: "interviewai-1cbea.firebaseapp.com",
  projectId: "interviewai-1cbea",
  storageBucket: "interviewai-1cbea.firebasestorage.app",
  messagingSenderId: "627946903412",
  appId: "1:627946903412:web:49ba0c2a969e7c8bc83e21",
  measurementId: "G-Q90VW5DNM6"
};

// Initialize app once and export commonly used Firebase services.
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);