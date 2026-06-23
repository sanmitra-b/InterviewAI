import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

// Backend host candidates and target question count for each interview session.
const API_BASE_URLS = [
  "http://127.0.0.1:5001",
  "http://localhost:5001",
  "http://127.0.0.1:5000",
  "http://localhost:5000"
];
let activeApiBaseUrl = API_BASE_URLS[0];

async function fetchWithApiFallback(path, options) {
  let lastError = null;
  for (const baseUrl of API_BASE_URLS) {
    try {
      const response = await fetch(`${baseUrl}${path}`, options);
      activeApiBaseUrl = baseUrl;
      return response;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Failed to fetch");
}

const QUESTIONS_PER_SESSION = 4;

let currentUser = null;
let recognition = null;
let isRecording = false;
let fullTranscript = "";
let nextButtonAction = "next";

const sessionState = {
  role: "",
  resumeFile: null,
  resumeText: "",
  questions: [],
  answers: [],
  evaluations: [],
  currentIndex: 0,
  startedAt: null
};

// Cached DOM references for faster access and cleaner handlers.
const elements = {
  roleCards: Array.from(document.querySelectorAll(".role-card")),
  roleSelectionCard: document.getElementById("role-selection-card"),
  practiceSection: document.getElementById("practice-section"),
  selectedRoleLabel: document.getElementById("selected-role-label"),
  questionProgress: document.getElementById("question-progress"),
  questionsLoading: document.getElementById("questions-loading"),
  questionList: document.getElementById("question-list"),
  noQuestionMsg: document.getElementById("no-question-msg"),
  answerSection: document.getElementById("answer-section"),
  currentQuestion: document.getElementById("current-question"),
  transcriptText: document.getElementById("transcript-text"),
  recordBtn: document.getElementById("record-btn"),
  recordLabel: document.getElementById("record-label"),
  recordingIndicator: document.getElementById("recording-indicator"),
  submitSpeechBtn: document.getElementById("submit-speech-btn"),
  clearBtn: document.getElementById("clear-btn"),
  changeRoleBtn: document.getElementById("change-role-btn"),
  feedbackCard: document.getElementById("feedback-card"),
  nextQuestionBtn: document.getElementById("next-question-btn"),
  speakQuestionBtn: document.getElementById("speak-question-btn"),
  startInterviewBtn: document.getElementById("start-interview-btn"),
  setupStatus: document.getElementById("setup-status"),
  practiceResumeInput: document.getElementById("practice-resume-input"),
  practiceResumeName: document.getElementById("practice-resume-name")
};

onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }
  currentUser = user;
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await signOut(auth);
  window.location.href = "index.html";
});

elements.roleCards.forEach((card) => {
  card.addEventListener("click", () => {
    elements.roleCards.forEach((c) => c.classList.remove("selected"));
    card.classList.add("selected");
    sessionState.role = card.dataset.role;
    updateSetupState();
  });
});

elements.practiceResumeInput.addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) {
    sessionState.resumeFile = null;
    elements.practiceResumeName.textContent = "No file selected";
    updateSetupState();
    return;
  }

  if (!file.name.toLowerCase().endsWith(".pdf")) {
    sessionState.resumeFile = null;
    elements.practiceResumeInput.value = "";
    elements.practiceResumeName.textContent = "Please upload a PDF file only.";
    updateSetupState();
    return;
  }

  sessionState.resumeFile = file;
  elements.practiceResumeName.textContent = `Selected: ${file.name}`;
  updateSetupState();
});

elements.startInterviewBtn.addEventListener("click", startInterviewFlow);

elements.changeRoleBtn.addEventListener("click", resetToSetup);

elements.recordBtn.addEventListener("click", () => {
  if (isRecording) {
    stopRecording();
    return;
  }
  startRecording();
});

elements.clearBtn.addEventListener("click", () => {
  fullTranscript = "";
  elements.transcriptText.style.color = "#666";
  elements.transcriptText.textContent = "Your answer will appear here as you speak...";
  if (isRecording) stopRecording();
});

elements.submitSpeechBtn.addEventListener("click", submitAnswerForFeedback);

elements.nextQuestionBtn.addEventListener("click", handleNextButtonClick);

elements.speakQuestionBtn.addEventListener("click", () => {
  const question = sessionState.questions[sessionState.currentIndex];
  if (question) {
    speakText(question);
  }
});

function updateSetupState() {
  // Enable start only after role selection and PDF upload are complete.
  const canStart = Boolean(sessionState.role && sessionState.resumeFile);
  elements.startInterviewBtn.disabled = !canStart;

  if (!sessionState.role) {
    elements.setupStatus.textContent = "Select a job role";
    return;
  }

  if (!sessionState.resumeFile) {
    elements.setupStatus.textContent = "Upload your resume PDF";
    return;
  }

  elements.setupStatus.textContent = "Ready to start";
}

async function startInterviewFlow() {
  // End-to-end setup: extract resume text, generate questions, and initialize UI.
  if (!sessionState.role || !sessionState.resumeFile) return;

  try {
    elements.startInterviewBtn.disabled = true;
    elements.setupStatus.textContent = "Extracting resume text...";

    const resumeText = await uploadResumeAndExtractText(sessionState.resumeFile);
    sessionState.resumeText = resumeText;

    elements.setupStatus.textContent = "Generating questions...";

    const questions = await generateQuestions(sessionState.role, resumeText);
    if (!questions.length) {
      throw new Error("No questions received from server.");
    }

    sessionState.questions = questions.slice(0, QUESTIONS_PER_SESSION);
    sessionState.answers = new Array(sessionState.questions.length).fill("");
    sessionState.evaluations = new Array(sessionState.questions.length).fill(null);
    sessionState.currentIndex = 0;
    sessionState.startedAt = new Date().toISOString();

    elements.roleSelectionCard.style.display = "none";
    elements.practiceSection.style.display = "block";
    elements.selectedRoleLabel.textContent = sessionState.role;

    renderQuestionList();
    showCurrentQuestion();
    speakText(sessionState.questions[0]);
  } catch (error) {
    elements.setupStatus.textContent = error.message || "Unable to start interview.";
    elements.startInterviewBtn.disabled = false;
  }
}

async function uploadResumeAndExtractText(file) {
  // Upload the selected resume and return extracted text from backend.
  const formData = new FormData();
  formData.append("resume", file);

  const response = await fetchWithApiFallback("/upload-resume", {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || "Resume upload failed.");
  }

  const data = await response.json();
  return data.resume_text || "";
}

async function generateQuestions(role, resumeText) {
  // Request role-specific questions based on resume context.
  const response = await fetchWithApiFallback("/generate-questions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role, resume_text: resumeText, count: QUESTIONS_PER_SESSION })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || "Question generation failed.");
  }

  const data = await response.json();
  return Array.isArray(data.questions) ? data.questions : [];
}

function renderQuestionList() {
  // Render clickable question list and bind question navigation.
  elements.questionsLoading.style.display = "none";
  elements.questionList.style.display = "flex";
  elements.questionList.innerHTML = "";

  sessionState.questions.forEach((question, index) => {
    const item = document.createElement("div");
    item.className = "question-item";
    item.textContent = `Q${index + 1}. ${question}`;
    item.addEventListener("click", () => {
      sessionState.currentIndex = index;
      showCurrentQuestion();
    });
    elements.questionList.appendChild(item);
  });
}

function showCurrentQuestion() {
  // Display currently selected question, previous answer, and feedback state.
  const question = sessionState.questions[sessionState.currentIndex] || "";

  elements.noQuestionMsg.style.display = "none";
  elements.answerSection.style.display = "block";
  elements.currentQuestion.textContent = question;
  elements.questionProgress.textContent = `Question ${sessionState.currentIndex + 1} / ${sessionState.questions.length}`;

  Array.from(elements.questionList.children).forEach((child, index) => {
    child.classList.toggle("selected", index === sessionState.currentIndex);
    child.classList.toggle("answered", Boolean(sessionState.evaluations[index]));
  });

  fullTranscript = sessionState.answers[sessionState.currentIndex] || "";
  if (fullTranscript) {
    elements.transcriptText.style.color = "#fff";
    elements.transcriptText.textContent = fullTranscript;
  } else {
    elements.transcriptText.style.color = "#666";
    elements.transcriptText.textContent = "Your answer will appear here as you speak...";
  }

  const existingEvaluation = sessionState.evaluations[sessionState.currentIndex];
  if (existingEvaluation) {
    showFeedback(existingEvaluation);
    const isLast = sessionState.currentIndex === sessionState.questions.length - 1;
    if (isLast) {
      setNextButton("finish");
      elements.nextQuestionBtn.style.display = "inline-block";
    } else {
      setNextButton("next");
      elements.nextQuestionBtn.style.display = "inline-block";
    }
  } else {
    elements.feedbackCard.style.display = "none";
    elements.nextQuestionBtn.style.display = "none";
  }
}

function setNextButton(action) {
  nextButtonAction = action;
  elements.nextQuestionBtn.textContent = action === "finish" ? "Finish Session" : "Next Question";
}

function handleNextButtonClick() {
  if (nextButtonAction === "finish") {
    finishSession();
    return;
  }

  if (sessionState.currentIndex >= sessionState.questions.length - 1) {
    return;
  }

  sessionState.currentIndex += 1;
  showCurrentQuestion();
}

function setupSpeechRecognition() {
  // Configure browser speech recognition for continuous dictation.
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    alert("Speech recognition is not supported in this browser. Use Chrome.");
    return null;
  }

  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = "en-US";

  rec.onresult = (event) => {
    let interim = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        fullTranscript += `${event.results[i][0].transcript} `;
      } else {
        interim = event.results[i][0].transcript;
      }
    }

    elements.transcriptText.style.color = "#fff";
    elements.transcriptText.textContent = (fullTranscript + interim).trim();
  };

  rec.onerror = () => stopRecording();
  rec.onend = () => {
    if (isRecording) {
      try {
        rec.start();
      } catch {
        stopRecording();
      }
    }
  };

  return rec;
}

function startRecording() {
  // Start voice capture and reset visible transcript output.
  recognition = setupSpeechRecognition();
  if (!recognition) return;

  fullTranscript = "";
  elements.transcriptText.textContent = "";

  recognition.start();
  isRecording = true;

  elements.recordBtn.classList.add("recording");
  elements.recordLabel.textContent = "Stop Speaking";
  elements.recordingIndicator.style.display = "flex";
}

function stopRecording() {
  // Stop voice capture and reset recording controls.
  if (recognition) {
    try {
      recognition.stop();
    } catch {
      // Ignore stop errors when recognizer is already stopped.
    }
  }

  isRecording = false;
  elements.recordBtn.classList.remove("recording");
  elements.recordLabel.textContent = "Start Speaking";
  elements.recordingIndicator.style.display = "none";
}

function speakText(text) {
  // Read prompt text aloud using browser speech synthesis.
  if (!("speechSynthesis" in window)) return;

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1;
  utterance.pitch = 1;
  utterance.lang = "en-US";
  window.speechSynthesis.speak(utterance);
}

async function submitAnswerForFeedback() {
  // Submit current answer for AI scoring and coaching feedback.
  const answer = fullTranscript.trim();
  if (!answer) {
    alert("Please record your answer before submitting.");
    return;
  }

  if (isRecording) stopRecording();

  const question = sessionState.questions[sessionState.currentIndex];
  sessionState.answers[sessionState.currentIndex] = answer;

  elements.feedbackCard.style.display = "block";
  elements.feedbackCard.innerHTML = `
    <h2><i class=\"fa-solid fa-lightbulb icon-left\"></i>AI Feedback</h2>
    <div class=\"feedback-placeholder\">
      <div class=\"placeholder-icon\"><i class=\"fa-solid fa-spinner fa-spin\"></i></div>
      <p>Analyzing your answer...</p>
    </div>`;

  try {
    const response = await fetchWithApiFallback("/evaluate-answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, answer, role: sessionState.role })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || "Answer evaluation failed.");
    }

    const data = await response.json();
    sessionState.evaluations[sessionState.currentIndex] = data;

    const latestScore = Number(data?.score);
    if (currentUser?.uid && Number.isFinite(latestScore)) {
      await setDoc(
        doc(db, "students", currentUser.uid),
        {
          practiceScore: latestScore,
          updatedAt: new Date(),
        },
        { merge: true }
      );
    }

    showFeedback(data);

    const isLast = sessionState.currentIndex === sessionState.questions.length - 1;
    if (isLast) {
      elements.nextQuestionBtn.style.display = "inline-block";
      setNextButton("finish");
    } else {
      elements.nextQuestionBtn.style.display = "inline-block";
      setNextButton("next");
    }

    Array.from(elements.questionList.children)[sessionState.currentIndex]?.classList.add("answered");
  } catch (error) {
    elements.feedbackCard.innerHTML = `
      <h2><i class=\"fa-solid fa-lightbulb icon-left\"></i>AI Feedback</h2>
      <div class=\"result-box\">
        <p style=\"color:#ff6b6b;\">${error.message || "Could not evaluate answer."}</p>
      </div>`;
  }
}

function showFeedback(data) {
  // Render structured answer evaluation in the feedback card.
  elements.feedbackCard.style.display = "block";
  elements.feedbackCard.innerHTML = `
    <h2><i class="fa-solid fa-lightbulb icon-left"></i>AI Feedback</h2>
    <div class="body-score-row" style="margin-bottom:16px;">
      <span>Answer Score:</span>
      <span class="rating-badge">${data.score ?? "—"}/10</span>
    </div>
    <div class="result-section">
      <h3>Strengths</h3>
      <ul class="result-list">${(data.strengths || []).map((s) => `<li>${s}</li>`).join("")}</ul>
    </div>
    <div class="result-section">
      <h3>Improvements</h3>
      <ul class="result-list">${(data.improvements || []).map((i) => `<li>${i}</li>`).join("")}</ul>
    </div>
    <div class="result-section">
      <h3>Overall Feedback</h3>
      <p class="feedback-text">${data.feedback || ""}</p>
    </div>
    <div class="result-section">
      <h3>Sample Answer</h3>
      <p class="feedback-text">${data.sample_answer || ""}</p>
    </div>`;
}

async function finishSession() {
  // Persist full practice session to backend and lock completed UI.
  try {
    elements.nextQuestionBtn.disabled = true;
    elements.nextQuestionBtn.textContent = "Saving...";

    const payload = {
      student_id: currentUser?.uid || "anonymous",
      role: sessionState.role,
      questions: sessionState.questions,
      answers: sessionState.answers,
      scores: sessionState.evaluations.map((item) => item?.score ?? null),
      evaluations: sessionState.evaluations,
      timestamp: new Date().toISOString(),
      started_at: sessionState.startedAt
    };

    const response = await fetchWithApiFallback("/save-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || "Failed to save session.");
    }

    const average = computeAverageScore(sessionState.evaluations);
    elements.feedbackCard.innerHTML = `
      <h2><i class=\"fa-solid fa-chart-column icon-left\"></i>Session Complete</h2>
      <div class=\"score-highlight\">
        <span class=\"big-score\">${average.toFixed(1)}<span style=\"font-size:1.5rem\">/10</span></span>
        <span class=\"score-label\">Average Score</span>
      </div>
      <p class=\"feedback-text\">Great work. Your full interview session has been saved.</p>`;

    elements.nextQuestionBtn.style.display = "none";
    elements.submitSpeechBtn.disabled = true;
    elements.recordBtn.disabled = true;
    elements.clearBtn.disabled = true;
    elements.speakQuestionBtn.disabled = true;
  } catch (error) {
    elements.nextQuestionBtn.disabled = false;
    elements.nextQuestionBtn.textContent = "Finish Session";
    alert(error.message || "Could not save session.");
  }
}

function computeAverageScore(evaluations) {
  // Compute arithmetic mean from valid numeric answer scores.
  const numeric = evaluations
    .map((item) => (typeof item?.score === "number" ? item.score : Number(item?.score)))
    .filter((value) => Number.isFinite(value));

  if (!numeric.length) return 0;
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function resetToSetup() {
  // Return to initial setup state while preserving selected auth session.
  if (isRecording) stopRecording();
  window.speechSynthesis?.cancel();

  sessionState.questions = [];
  sessionState.answers = [];
  sessionState.evaluations = [];
  sessionState.currentIndex = 0;
  sessionState.startedAt = null;

  elements.practiceSection.style.display = "none";
  elements.roleSelectionCard.style.display = "block";
  elements.feedbackCard.style.display = "none";
  elements.answerSection.style.display = "none";
  elements.questionsLoading.style.display = "flex";
  elements.questionsLoading.innerHTML = `
    <div class="placeholder-icon"><i class="fa-solid fa-spinner fa-spin"></i></div>
    <p>Loading questions...</p>`;
  elements.questionList.style.display = "none";
  elements.questionList.innerHTML = "";

  elements.submitSpeechBtn.disabled = false;
  elements.recordBtn.disabled = false;
  elements.clearBtn.disabled = false;
  elements.speakQuestionBtn.disabled = false;
  elements.nextQuestionBtn.disabled = false;
  elements.nextQuestionBtn.style.display = "none";
  setNextButton("next");

  updateSetupState();
}

updateSetupState();
