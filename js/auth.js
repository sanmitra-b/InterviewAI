import { auth, db } from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
import { doc, setDoc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

// Shared Google provider instance for OAuth login/signup.
const provider = new GoogleAuthProvider();

// ── Helper: show error message ──
function showError(msg) {
  const el = document.getElementById("error-message");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
}

// ── Helper: save student profile to Firestore ──
async function saveStudentProfile(user, name = "") {
  // Create a student document only once on first sign-in.
  const ref = doc(db, "students", user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      name: name || user.displayName || "Student",
      email: user.email,
      createdAt: new Date(),
      feedbackHistory: []
    });
  }
}

// ── LOGIN FORM ──
const loginForm = document.getElementById("login-form");
if (loginForm) {
  loginForm.addEventListener("submit", async (e) => {
    // Authenticate existing users and redirect to main app.
    e.preventDefault();
    const email = document.getElementById("login-email").value;
    const password = document.getElementById("login-password").value;
    try {
      await signInWithEmailAndPassword(auth, email, password);
      window.location.href = "resume.html";
    } catch (err) {
      showError("Invalid email or password. Please try again.");
    }
  });
}

// ── SIGNUP FORM ──
const signupForm = document.getElementById("signup-form");
if (signupForm) {
  signupForm.addEventListener("submit", async (e) => {
    // Register new users, bootstrap profile data, then redirect.
    e.preventDefault();
    const name = document.getElementById("signup-name").value;
    const email = document.getElementById("signup-email").value;
    const password = document.getElementById("signup-password").value;
    if (password.length < 6) {
      showError("Password must be at least 6 characters.");
      return;
    }
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await saveStudentProfile(cred.user, name);
      window.location.href = "resume.html";
    } catch (err) {
      showError("Account already exists or invalid email.");
    }
  });
}

// ── GOOGLE SIGN IN (works on both login & signup page) ──
const googleBtn = document.getElementById("google-login-btn");
if (googleBtn) {
  googleBtn.addEventListener("click", async () => {
    // Sign in with Google on either auth screen.
    try {
      const cred = await signInWithPopup(auth, provider);
      await saveStudentProfile(cred.user);
      window.location.href = "resume.html";
    } catch (err) {
      showError("Google sign-in failed. Please try again.");
    }
  });
}

// ── AUTH GUARD: redirect to dashboard if already logged in ──
onAuthStateChanged(auth, (user) => {
  const onAuthPage = document.getElementById("login-form") || document.getElementById("signup-form");
  if (user && onAuthPage) {
    window.location.href = "resume.html";
  }
});