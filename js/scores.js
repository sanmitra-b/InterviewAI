import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

// Current authenticated user (used for score document lookup).
let currentUser = null;

function parseScore(value) {
  // Normalize Firestore values to finite numbers; return null if missing/invalid.
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function hasScore(value) {
  // Treat 0 as a valid score.
  return value !== null && value !== undefined;
}

// ── AUTH GUARD ──
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }
  currentUser = user;
  loadScores(user);
});

// ── LOGOUT ──
document.getElementById("logout-btn").addEventListener("click", async () => {
  await signOut(auth);
  window.location.href = "index.html";
});

// ── LOAD SCORES FROM FIRESTORE ──
async function loadScores(user) {
  // Fetch latest module scores and project them into dashboard cards.
  const snap = await getDoc(doc(db, "students", user.uid));
  if (!snap.exists()) return;

  const data = snap.data();

  const resumeRating = parseScore(data.resumeRating);
  const resumeMatch = parseScore(data.resumeMatch);
  const practiceScore = parseScore(data.practiceScore);
  const bodyScore = parseScore(data.bodyScore);

  // Update each score card
  updateScoreCard(
    "resume-score-pill", "resume-bar", "resume-score-msg",
    resumeRating, 10,
    "Your resume analysis is ready."
  );

  updateScoreCard(
    "match-score-pill", "match-bar", "match-score-msg",
    resumeMatch, 100,
    `${resumeMatch}% match with job description`,
    true
  );

  updateScoreCard(
    "practice-score-pill", "practice-bar", "practice-score-msg",
    practiceScore, 10,
    "Answer scored successfully."
  );

  updateScoreCard(
    "body-score-pill", "body-bar", "body-score-msg",
    bodyScore, 10,
    "Body language session completed."
  );

  // Calculate overall score
  calculateOverall(resumeRating, resumeMatch, practiceScore, bodyScore);

  // Generate tips
  generateTips(resumeRating, resumeMatch, practiceScore, bodyScore);
}

// ── UPDATE INDIVIDUAL SCORE CARD ──
function updateScoreCard(pillId, barId, msgId, score, max, successMsg, isPercent = false) {
  // Update one score card (pill, progress bar, and helper message).
  if (score === null || score === undefined) return;

  const pill = document.getElementById(pillId);
  const bar = document.getElementById(barId);
  const msg = document.getElementById(msgId);

  pill.textContent = isPercent ? `${score}%` : `${score}/10`;
  pill.classList.add("has-score");

  const percent = isPercent ? score : (score / max) * 100;
  bar.style.width = `${percent}%`;
  bar.style.background = percent >= 70 ? "#4caf50" : percent >= 40 ? "#ff9800" : "#ff4444";

  msg.textContent = successMsg;
  msg.style.color = "#4caf50";
}

// ── CALCULATE OVERALL SCORE ──
function calculateOverall(resumeRating, resumeMatch, practiceScore, bodyScore) {
  // Compute normalized average readiness score (0-10) across completed modules.
  const scores = [];

  if (hasScore(resumeRating)) scores.push(resumeRating);
  if (hasScore(resumeMatch)) scores.push(resumeMatch / 10);
  if (hasScore(practiceScore)) scores.push(practiceScore);
  if (hasScore(bodyScore)) scores.push(bodyScore);

  if (scores.length === 0) return;

  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const rounded = Math.round(avg * 10) / 10;
  const percent = Math.round((avg / 10) * 100);

  document.getElementById("overall-score").textContent = rounded;
  document.getElementById("readiness-bar").style.width = `${percent}%`;
  document.getElementById("readiness-bar").style.background =
    percent >= 70 ? "#4caf50" : percent >= 40 ? "#ff9800" : "#ff4444";
  document.getElementById("readiness-percent").textContent = `${percent}%`;

  let message = "";
  if (percent >= 80) message = "You are highly interview ready.";
  else if (percent >= 60) message = "Good progress. A bit more practice will strengthen your performance.";
  else if (percent >= 40) message = "Keep going. You are making progress.";
  else message = "You are just getting started. Complete all sections.";

  document.getElementById("overall-message").textContent = message;
}

// ── GENERATE TIPS ──
function generateTips(resumeRating, resumeMatch, practiceScore, bodyScore) {
  // Generate actionable tips based on missing modules or low scores.
  const tips = [];

  if (!hasScore(resumeRating)) {
    tips.push({ icon: '<i class="fa-regular fa-file-lines"></i>', tip: "Upload your resume and get it reviewed by AI." });
  } else if (resumeRating < 6) {
    tips.push({ icon: '<i class="fa-regular fa-file-lines"></i>', tip: "Your resume score is low. Check the feedback and improve your resume." });
  }

  if (!hasScore(resumeMatch)) {
    tips.push({ icon: '<i class="fa-solid fa-percent"></i>', tip: "Run a match score to see how well your resume fits the job." });
  } else if (resumeMatch < 60) {
    tips.push({ icon: '<i class="fa-solid fa-percent"></i>', tip: "Your resume match is below 60%. Add more relevant keywords from the job description." });
  }

  if (!hasScore(practiceScore)) {
    tips.push({ icon: '<i class="fa-solid fa-microphone"></i>', tip: "Practice answering AI mock questions using your voice." });
  } else if (practiceScore < 6) {
    tips.push({ icon: '<i class="fa-solid fa-microphone"></i>', tip: "Your answer score needs improvement. Review sample answers and practice more." });
  }

  if (!hasScore(bodyScore)) {
    tips.push({ icon: '<i class="fa-solid fa-video"></i>', tip: "Complete a body language session to check your posture and confidence." });
  } else if (bodyScore < 6) {
    tips.push({ icon: '<i class="fa-solid fa-video"></i>', tip: "Work on your posture and eye contact during interviews." });
  }

  if (tips.length === 0) {
    tips.push({ icon: '<i class="fa-solid fa-circle-check"></i>', tip: "Great job. You've completed all sections. Keep practicing to maintain your scores." });
  }

  const container = document.getElementById("tips-list");
  container.innerHTML = tips.map(t => `
    <div class="tip-item">
      <span class="tip-icon">${t.icon}</span>
      <p>${t.tip}</p>
    </div>
  `).join("");
}