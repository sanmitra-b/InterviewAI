import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

// Backend API base for Flask endpoints.
const FLASK_URL = "http://localhost:5000";
let currentUser = null;
let uploadedFile = null;

function createSessionId() {
  // Generate a stable unique id for each saved analysis session.
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `sess_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

// ── AUTH GUARD ──
onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }
  currentUser = user;
});

// ── LOGOUT ──
document.getElementById("logout-btn").addEventListener("click", async () => {
  await signOut(auth);
  window.location.href = "index.html";
});

// ── FILE SELECTION ──
document.getElementById("resume-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  uploadedFile = file;
  document.getElementById("file-name-display").textContent = `Selected: ${file.name}`;
});

// ── REVIEW RESUME ──
document.getElementById("review-btn").addEventListener("click", () => {
  analyzeResume("review");
});

// ── MATCH SCORE ──
document.getElementById("match-btn").addEventListener("click", () => {
  analyzeResume("match");
});

// ── ANALYZE RESUME ──
async function analyzeResume(type) {
  // Send resume + options to backend and persist summarized outputs.
  if (!uploadedFile) {
    showStatus("Please upload a resume file first.", "error");
    return;
  }

  showStatus("Analyzing your resume... please wait", "loading");
  document.getElementById("results-card").style.display = "none";

  try {
    // 1. Send to Flask for AI analysis
    const formData = new FormData();
    formData.append("resume", uploadedFile);
    formData.append("job_description", document.getElementById("job-description").value);
    formData.append("type", type);

    const response = await fetch(`${FLASK_URL}/scan-resume`, {
      method: "POST",
      body: formData
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }

    const data = await response.json();

    if (data.error) {
      showStatus(`Error: ${data.error}`, "error");
      return;
    }

    // Save lightweight outputs to Firestore (no media persistence).
    const now = new Date();
    const sessionId = createSessionId();
    const studentRef = doc(db, "students", currentUser.uid);
    const sessionRef = doc(db, "students", currentUser.uid, "sessions", sessionId);

    if (type === "review" && data.rating !== undefined) {
      await setDoc(studentRef, {
        resumeRating: data.rating,
        resumeStrengths: data.strengths || [],
        resumeWeaknesses: data.weaknesses || [],
        resumeFeedback: data.feedback || "",
        updatedAt: now
      }, { merge: true });

      await setDoc(sessionRef, {
        sessionId,
        module: "resume",
        analysisType: "review",
        timestamp: now,
        score: data.rating,
        strengths: data.strengths || [],
        weaknesses: data.weaknesses || [],
        feedback: data.feedback || "",
        confidence: data.rating
      });
    } else if (type === "match" && data.percentage !== undefined) {
      await setDoc(studentRef, {
        resumeMatch: data.percentage,
        resumeStrengths: data.strengths || [],
        resumeMissingKeywords: data.missing_keywords || [],
        resumeFeedback: data.feedback || "",
        updatedAt: now
      }, { merge: true });

      await setDoc(sessionRef, {
        sessionId,
        module: "resume",
        analysisType: "match",
        timestamp: now,
        score: data.percentage,
        strengths: data.strengths || [],
        missingKeywords: data.missing_keywords || [],
        feedback: data.feedback || "",
        confidence: data.percentage
      });
    }

    showStatus("Analysis complete.", "success");
    showResults(data, type);

  } catch (err) {
    showStatus("Could not connect to Flask server. Make sure your teammate has it running.", "error");
  }
}

// ── SHOW RESULTS ──
function showResults(data, type) {
  // Render analysis payload into the results card.
  const card = document.getElementById("results-card");
  card.style.display = "block";

  // Title
  document.getElementById("results-title").textContent =
    type === "match" ? "Match Score Analysis" : "Resume Review";

  // Score highlight
  const scoreEl = document.getElementById("score-highlight");
  if (type === "match" && data.percentage !== undefined) {
    scoreEl.innerHTML = `<span class="big-score">${data.percentage}%</span><span class="score-label">Match Score</span>`;
    scoreEl.style.display = "flex";
  } else if (data.rating !== undefined) {
    scoreEl.innerHTML = `<span class="big-score">${data.rating}<span style="font-size:1.5rem">/10</span></span><span class="score-label">Resume Rating</span>`;
    scoreEl.style.display = "flex";
  } else {
    scoreEl.style.display = "none";
  }

  // Strengths
  const strengthsList = document.getElementById("strengths-list");
  if (data.strengths && data.strengths.length > 0) {
    strengthsList.innerHTML = data.strengths.map(s => `<li>${s}</li>`).join("");
    document.getElementById("strengths-section").style.display = "block";
  }

  // Weaknesses / Missing Keywords
  const weaknessesList = document.getElementById("weaknesses-list");
  const weaknessesSection = document.getElementById("weaknesses-section");
  if (type === "match" && data.missing_keywords && data.missing_keywords.length > 0) {
    document.getElementById("weaknesses-title").textContent = "Missing Keywords";
    weaknessesList.innerHTML = data.missing_keywords.map(k => `<li>${k}</li>`).join("");
    weaknessesSection.style.display = "block";
  } else if (data.weaknesses && data.weaknesses.length > 0) {
    document.getElementById("weaknesses-title").textContent = "Areas to Improve";
    weaknessesList.innerHTML = data.weaknesses.map(w => `<li>${w}</li>`).join("");
    weaknessesSection.style.display = "block";
  }

  // Feedback
  document.getElementById("feedback-text").textContent = data.feedback || "";

  card.scrollIntoView({ behavior: "smooth" });
}

// ── STATUS HELPER ──
function showStatus(msg, type) {
  // Unified status line helper for upload/analysis progress and errors.
  const el = document.getElementById("upload-status");
  el.textContent = msg;
  el.style.color = type === "error" ? "#ff6b6b" : type === "success" ? "#4caf50" : "#6c63ff";
}

