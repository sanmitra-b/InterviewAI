import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";
import { FilesetResolver, PoseLandmarker, FaceLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

// Flask endpoint and analysis thresholds used by client-side MediaPipe scoring.
const FLASK_URL = "http://localhost:5000";
const BODY_ANALYSIS_THRESHOLDS = {
  face: {
    minLandmarks: 10,
    irisLandmarksMin: 478
  },
  eye: {
    calibratedLeftMin: 2.52,
    calibratedLeftMax: 2.96,
    calibratedRightMin: -2.96,
    calibratedRightMax: -2.52,
    lookingAwaySeconds: 2
  },
  posture: {
    slouchingDeviationDeg: 7,
    headTiltDeg: 8,
    headMovementScore: 9
  },
  motion: {
    headMotionScale: 500,
    headMotionCap: 100
  },
  performance: {
    liveIntervalMs: 60,
    slowFrameDelayCapMs: 130,
    slowFrameDelayFactor: 0.25,
    historyCapFrames: 1800
  },
  smoothing: {
    historySize: 5
  }
};
const LIVE_INTERVAL_MS = BODY_ANALYSIS_THRESHOLDS.performance.liveIntervalMs;

// Camera constraints tuned for stable browser inference and visual quality.
const CAMERA_CONSTRAINTS = {
  width: { ideal: 1280, max: 1280 },
  height: { ideal: 720, max: 720 },
  frameRate: { ideal: 30, max: 30 },
  facingMode: "user"
};
let currentUser = null;
let stream = null;
let selectedVideoFile = null;
let uploadedVideoUrl = null;
let liveAnalysisInterval = null;
let liveMetricsHistory = [];
let isAnalyzingFrame = false;
let liveSessionId = null;
let analysisSource = "idle";
let poseLandmarker = null;
let faceLandmarker = null;
let mediaPipeInitPromise = null;
let previousNosePoint = null;
let lookingAwaySinceMs = null;
let latestEyeContactScore = 100;
let lastEyeContactMaintained = true;
let eyeContactScoredFrames = 0;
let eyeContactCenteredFrames = 0;
let latestCumulativeEyeContactScore = 100;

// Short rolling history for smoothing jittery frame-level metrics.
const metricHistory = {
  shoulderAngle: [],
  headTilt: []
};

function createSessionId() {
  // Generate unique identifiers for persisted posture sessions.
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

// ── START CAMERA ──
document.getElementById("start-camera-btn").addEventListener("click", async () => {
  try {
    await ensureMediaPipeReady();
    stopUploadedVideoPlayback();
    stream = await navigator.mediaDevices.getUserMedia({ video: CAMERA_CONSTRAINTS, audio: false });
    const video = document.getElementById("camera-feed");
    const cameraBox = document.getElementById("camera-box");
    video.src = "";
    video.srcObject = stream;
    cameraBox.classList.add("live-camera-mode");

    // Hide overlay, show live badge and scan line
    document.getElementById("camera-overlay").style.display = "none";
    document.getElementById("live-badge").style.display = "flex";
    document.getElementById("live-badge").innerHTML = `<span class="live-dot"></span> LIVE`;
    document.getElementById("stop-camera-btn").style.display = "block";
    document.getElementById("body-feedback-placeholder").style.display = "flex";
    document.getElementById("body-feedback-placeholder").innerHTML =
      `<div class="placeholder-icon"><i class="fa-solid fa-wave-square"></i></div><p>Live analysis running. Stop camera to generate final feedback.</p>`;
    document.getElementById("body-feedback-result").style.display = "none";

    liveSessionId = createSessionId();
    liveMetricsHistory = [];
    eyeContactScoredFrames = 0;
    eyeContactCenteredFrames = 0;
    latestCumulativeEyeContactScore = 100;
    analysisSource = "camera";
    startContinuousAnalysis();

  } catch (err) {
    alert("Could not access camera. Please allow camera permissions.");
  }
});

// ── STOP CAMERA ──
document.getElementById("stop-camera-btn").addEventListener("click", () => {
  stopContinuousAnalysis();

  const wasAnalyzing = analysisSource !== "idle";
  const hadMetrics = liveMetricsHistory.length > 0;

  stopCameraStream();
  stopUploadedVideoPlayback();
  document.getElementById("camera-overlay").style.display = "flex";
  document.getElementById("live-badge").style.display = "none";
  document.getElementById("stop-camera-btn").style.display = "none";
  analysisSource = "idle";

  if (wasAnalyzing && hadMetrics) {
    finalizeLiveSession();
  }

  closeLiveBackendSession();

  resetMetrics();
});

async function closeLiveBackendSession() {
  // Notify backend to release per-session resources for frame analysis.
  if (!liveSessionId) return;

  try {
    await fetch(`${FLASK_URL}/end-body-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: liveSessionId })
    });
  } catch (err) {
    console.warn("Could not close backend body session", err);
  } finally {
    liveSessionId = null;
  }
}

function stopCameraStream() {
  // Stop all active camera tracks and reset camera mode styles.
  if (!stream) return;
  stream.getTracks().forEach(track => track.stop());
  stream = null;
  document.getElementById("camera-box").classList.remove("live-camera-mode");
}

function stopUploadedVideoPlayback() {
  // Release uploaded video object URL and reset media element source.
  const video = document.getElementById("camera-feed");
  video.pause();
  video.removeAttribute("src");
  video.load();

  if (uploadedVideoUrl) {
    URL.revokeObjectURL(uploadedVideoUrl);
    uploadedVideoUrl = null;
  }
}

function startContinuousAnalysis() {
  // Begin frame analysis loop using adaptive scheduling.
  stopContinuousAnalysis();
  scheduleNextAnalysisTick(0);
}

function stopContinuousAnalysis() {
  if (liveAnalysisInterval) {
    clearTimeout(liveAnalysisInterval);
    liveAnalysisInterval = null;
  }
}

function scheduleNextAnalysisTick(delayMs = LIVE_INTERVAL_MS) {
  if (analysisSource === "idle") return;
  liveAnalysisInterval = setTimeout(analyzeLiveFrameTick, delayMs);
}

async function ensureMediaPipeReady() {
  // Lazily initialize MediaPipe pose + face models once per page session.
  if (poseLandmarker && faceLandmarker) return;
  if (mediaPipeInitPromise) return mediaPipeInitPromise;

  mediaPipeInitPromise = (async () => {
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );

    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
      },
      runningMode: "VIDEO",
      numPoses: 1
    });

    faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
      },
      runningMode: "VIDEO",
      numFaces: 1
    });
  })();

  return mediaPipeInitPromise;
}

function resetMetrics() {
  // Reset live metric UI and internal temporal state.
  ["posture-value", "eye-value", "confidence-value", "expression-value"].forEach(id => {
    document.getElementById(id).textContent = "—";
  });
  const postureStatus = document.getElementById("posture-status-value");
  postureStatus.textContent = "—";
  postureStatus.classList.remove("good", "bad");
  document.getElementById("looking-away-value").textContent = "—";

  const canvas = document.getElementById("pose-canvas");
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);

  metricHistory.shoulderAngle = [];
  metricHistory.headTilt = [];
  latestEyeContactScore = 100;
  latestCumulativeEyeContactScore = 100;
  eyeContactScoredFrames = 0;
  eyeContactCenteredFrames = 0;
  lastEyeContactMaintained = true;
  lookingAwaySinceMs = null;
  previousNosePoint = null;
}

function setLoadingState(message) {
  // Display loading placeholder while long-running analysis completes.
  const placeholder = document.getElementById("body-feedback-placeholder");
  placeholder.style.display = "flex";
  placeholder.innerHTML = `<div class="placeholder-icon"><i class="fa-solid fa-spinner fa-spin"></i></div><p>${message}</p>`;
  document.getElementById("body-feedback-result").style.display = "none";
}

function updateLiveMetrics(liveMetrics = {}) {
  // Push latest computed metric values to overlay badges.
  document.getElementById("posture-value").textContent = liveMetrics.shoulderAngle || "—";
  document.getElementById("eye-value").textContent = liveMetrics.headTilt || "—";
  document.getElementById("confidence-value").textContent = liveMetrics.headMotion || "—";
  document.getElementById("expression-value").textContent = liveMetrics.eyeContactScore || "—";
  document.getElementById("looking-away-value").textContent = liveMetrics.lookingAway || "—";

  const postureStatus = document.getElementById("posture-status-value");
  const statusText = liveMetrics.postureStatus || "—";
  postureStatus.textContent = statusText;
  postureStatus.classList.remove("good", "bad");
  if (statusText === "Good Body Language") {
    postureStatus.classList.add("good");
  } else if (statusText !== "—") {
    postureStatus.classList.add("bad");
  }
}

function formatSignedDeviation(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  const rounded = value.toFixed(1);
  return value > 0 ? `+${rounded}` : rounded;
}

function drawClientOverlay(poseLandmarks = null) {
  // Draw lightweight shoulder guide line from pose landmarks.
  const canvas = document.getElementById("pose-canvas");
  const context = canvas.getContext("2d");
  const box = document.getElementById("camera-box");

  const canvasWidth = box.clientWidth;
  const canvasHeight = box.clientHeight;
  if (canvasWidth === 0 || canvasHeight === 0) return;

  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  context.clearRect(0, 0, canvasWidth, canvasHeight);

  if (!poseLandmarks || poseLandmarks.length === 0) {
    return;
  }

  const leftShoulder = poseLandmarks[11];
  const rightShoulder = poseLandmarks[12];

  if (leftShoulder && rightShoulder) {
    context.strokeStyle = "#6c63ff";
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(leftShoulder.x * canvasWidth, leftShoulder.y * canvasHeight);
    context.lineTo(rightShoulder.x * canvasWidth, rightShoulder.y * canvasHeight);
    context.stroke();
  }
}

function calculateSlopeAngle(pointA, pointB) {
  if (!pointA || !pointB) return 0;
  const radians = Math.atan2(pointB.y - pointA.y, pointB.x - pointA.x);
  return (radians * 180) / Math.PI;
}

function normalizeAngleToDeviation(angle) {
  if (typeof angle !== "number" || Number.isNaN(angle)) return 0;
  let normalized = angle;
  while (normalized > 180) normalized -= 360;
  while (normalized < -180) normalized += 360;
  if (normalized > 90) normalized -= 180;
  if (normalized < -90) normalized += 180;
  return normalized;
}

function calculateShoulderDeviationFrom180(leftShoulder, rightShoulder) {
  if (!leftShoulder || !rightShoulder) return 0;

  const radians = Math.atan2(leftShoulder.y - rightShoulder.y, leftShoulder.x - rightShoulder.x);
  let angle = (radians * 180) / Math.PI;
  if (angle < 0) angle += 360;

  let deviation = angle - 180;
  if (deviation > 180) deviation -= 360;
  if (deviation < -180) deviation += 360;
  if (deviation > 90) deviation -= 180;
  if (deviation < -90) deviation += 180;
  return deviation;
}

function smoothMetric(name, value) {
  // Apply moving average smoothing to selected metric stream.
  const history = metricHistory[name];
  if (!history || typeof value !== "number" || Number.isNaN(value)) {
    return value;
  }

  history.push(value);
  if (history.length > BODY_ANALYSIS_THRESHOLDS.smoothing.historySize) {
    history.shift();
  }

  const total = history.reduce((acc, current) => acc + current, 0);
  return total / history.length;
}

function getEyeContactSignal(faceLandmarks) {
  // Estimate eye-contact state using iris position relative to eye corners.
  if (!faceLandmarks || faceLandmarks.length < BODY_ANALYSIS_THRESHOLDS.face.minLandmarks) {

    return {
      leftIrisRelative: null,
      rightIrisRelative: null,
      eyeCentered: null,
      score: null,
      available: false
    };


  }

  if (faceLandmarks.length >= BODY_ANALYSIS_THRESHOLDS.face.irisLandmarksMin) {
    const leftIrisIdx = [474, 475, 476, 477];
    const rightIrisIdx = [469, 470, 471, 472];
    const leftIrisX = leftIrisIdx.reduce((sum, i) => sum + faceLandmarks[i].x, 0) / leftIrisIdx.length;
    const rightIrisX = rightIrisIdx.reduce((sum, i) => sum + faceLandmarks[i].x, 0) / rightIrisIdx.length;

    const leftEyeLeft = faceLandmarks[33].x;
    const leftEyeRight = faceLandmarks[133].x;
    const rightEyeLeft = faceLandmarks[263].x;
    const rightEyeRight = faceLandmarks[362].x;

    const leftEyeWidth = Math.abs(leftEyeRight - leftEyeLeft);
    const rightEyeWidth = Math.abs(rightEyeRight - rightEyeLeft);
    if (leftEyeWidth > 0 && rightEyeWidth > 0) {
      const leftIrisRelative = (leftIrisX - leftEyeLeft) / leftEyeWidth;
      const rightIrisRelative = (rightIrisX - rightEyeLeft) / rightEyeWidth;
      const leftCentered =
        leftIrisRelative >= BODY_ANALYSIS_THRESHOLDS.eye.calibratedLeftMin &&
        leftIrisRelative <= BODY_ANALYSIS_THRESHOLDS.eye.calibratedLeftMax;
      const rightCentered =
        rightIrisRelative >= BODY_ANALYSIS_THRESHOLDS.eye.calibratedRightMin &&
        rightIrisRelative <= BODY_ANALYSIS_THRESHOLDS.eye.calibratedRightMax;
      const eyeCentered = leftCentered && rightCentered;
      const score = eyeCentered ? 100 : 0;

      return {
        leftIrisRelative,
        rightIrisRelative,
        eyeCentered,
        score,
        available: true
      };
    }
  }

  return {
    leftIrisRelative: null,
    rightIrisRelative: null,
    eyeCentered: null,
    score: null,
    available: false
  };
}

function buildFrameMetrics(poseLandmarks, faceLandmarks, nowMs) {
  // Build one normalized frame metric object consumed by live UI + summary API.
  if (!poseLandmarks || poseLandmarks.length === 0) {
    return {
      shoulder_angle: 0,
      head_tilt: 0,
      head_motion_score: 0,
      eye_contact_maintained: false,
      eye_contact_score: 0,
      excessive_looking_away: true,
      eye_contact_duration: 0,
      is_slouching: false,
      is_tilted: false,
      is_head_moving: false,
      left_iris_relative: null,
      right_iris_relative: null,
      issues: ["Warning: Person Out of Frame"],
      status: "Warning: Person Out of Frame",
      timestamp: nowMs / 1000
    };
  }

  const leftShoulder = poseLandmarks[11];
  const rightShoulder = poseLandmarks[12];
  const leftEar = poseLandmarks[7];
  const rightEar = poseLandmarks[8];
  const nose = poseLandmarks[0];

  const shoulderDeviation = smoothMetric(
    "shoulderAngle",
    calculateShoulderDeviationFrom180(leftShoulder, rightShoulder)
  );
  const rawHeadTilt = calculateSlopeAngle(leftEar, rightEar);
  const headTiltDeviation = normalizeAngleToDeviation(rawHeadTilt);
  const headTilt = smoothMetric("headTilt", Math.abs(headTiltDeviation));

  let headMotionScore = 0;
  if (nose && previousNosePoint) {
    const dx = nose.x - previousNosePoint.x;
    const dy = nose.y - previousNosePoint.y;
    headMotionScore = Math.min(
      BODY_ANALYSIS_THRESHOLDS.motion.headMotionCap,
      Math.sqrt(dx * dx + dy * dy) * BODY_ANALYSIS_THRESHOLDS.motion.headMotionScale
    );
  }
  previousNosePoint = nose ? { x: nose.x, y: nose.y } : previousNosePoint;

  const {
    leftIrisRelative,
    rightIrisRelative,
    eyeCentered,
    score: eyeSignalScore,
    available: eyeSignalAvailable
  } = getEyeContactSignal(faceLandmarks);

  if (eyeSignalAvailable) {
    const targetScore = typeof eyeSignalScore === "number" ? eyeSignalScore : (eyeCentered ? 100 : 0);
    latestEyeContactScore = Math.max(0, Math.min(100, targetScore));

    eyeContactScoredFrames += 1;
    if (eyeCentered) {
      eyeContactCenteredFrames += 1;
    }
    latestCumulativeEyeContactScore = eyeContactScoredFrames > 0
      ? (eyeContactCenteredFrames / eyeContactScoredFrames) * 100
      : latestCumulativeEyeContactScore;

    if (eyeCentered) {
      lookingAwaySinceMs = null;
    } else {
      if (lookingAwaySinceMs == null) {
        lookingAwaySinceMs = nowMs;
      }
    }
    lastEyeContactMaintained = Boolean(eyeCentered);
  }

  const awayDurationSec = lookingAwaySinceMs == null ? 0 : (nowMs - lookingAwaySinceMs) / 1000;
  const excessiveLookingAway = eyeSignalAvailable ? awayDurationSec > BODY_ANALYSIS_THRESHOLDS.eye.lookingAwaySeconds : false;
  const isSlouching = Math.abs(shoulderDeviation) > BODY_ANALYSIS_THRESHOLDS.posture.slouchingDeviationDeg;
  const isTilted = headTilt > BODY_ANALYSIS_THRESHOLDS.posture.headTiltDeg;
  const isHeadMoving = headMotionScore > BODY_ANALYSIS_THRESHOLDS.posture.headMovementScore;

  const issues = [];
  if (isSlouching) issues.push("Shoulders Not Level");
  if (isTilted) issues.push("Head Tilted");
  if (isHeadMoving) issues.push("Excessive Head Movement");
  if (excessiveLookingAway) issues.push("Missing Eye Contact");

  return {
    shoulder_angle: shoulderDeviation,
    head_tilt: headTilt,
    head_motion_score: headMotionScore,
    eye_contact_maintained: eyeSignalAvailable ? Boolean(eyeCentered) : lastEyeContactMaintained,
    eye_contact_score: latestEyeContactScore,
    eye_contact_score_cumulative: latestCumulativeEyeContactScore,
    excessive_looking_away: excessiveLookingAway,
    eye_contact_duration: awayDurationSec,
    is_slouching: isSlouching,
    is_tilted: isTilted,
    is_head_moving: isHeadMoving,
    left_iris_relative: leftIrisRelative,
    right_iris_relative: rightIrisRelative,
    issues,
    status: issues.length === 0 ? "Good Body Language" : issues[0],
    timestamp: nowMs / 1000
  };
}

async function analyzeLiveFrameTick() {
  // Main adaptive frame loop: infer landmarks, compute metrics, and schedule next tick.
  if (isAnalyzingFrame || analysisSource === "idle") {
    if (analysisSource !== "idle") {
      scheduleNextAnalysisTick(24);
    }
    return;
  }

  const video = document.getElementById("camera-feed");
  if (analysisSource === "camera" && (!stream || !video.srcObject)) {
    scheduleNextAnalysisTick(30);
    return;
  }

  if (analysisSource === "uploaded" && (video.paused || video.ended)) {
    scheduleNextAnalysisTick(30);
    return;
  }

  if (video.videoWidth === 0 || video.videoHeight === 0) {
    scheduleNextAnalysisTick(30);
    return;
  }

  isAnalyzingFrame = true;

  const startedAt = performance.now();

  try {
    await ensureMediaPipeReady();
    const now = performance.now();
    const poseResult = poseLandmarker.detectForVideo(video, now);
    const faceResult = faceLandmarker.detectForVideo(video, now);

    const poseLandmarks = poseResult?.landmarks?.[0] || null;
    const faceLandmarks = faceResult?.faceLandmarks?.[0] || null;
    drawClientOverlay(poseLandmarks);

    const frameMetrics = buildFrameMetrics(poseLandmarks, faceLandmarks, now);

    if (frameMetrics && Object.keys(frameMetrics).length > 0) {
      updateLiveMetrics({
        shoulderAngle: typeof frameMetrics.shoulder_angle === "number" ? formatSignedDeviation(frameMetrics.shoulder_angle) : "—",
        headTilt: typeof frameMetrics.head_tilt === "number" ? frameMetrics.head_tilt.toFixed(1) : "—",
        headMotion: typeof frameMetrics.head_motion_score === "number" ? frameMetrics.head_motion_score.toFixed(1) : "—",
        eyeContactScore: typeof frameMetrics.eye_contact_score_cumulative === "number"
          ? `${frameMetrics.eye_contact_score_cumulative.toFixed(0)}%`
          : "—",
        lookingAway: frameMetrics.excessive_looking_away ? "Yes" : "No",
        postureStatus: frameMetrics.status || "Warning: Person Out of Frame"
      });
      liveMetricsHistory.push(frameMetrics);
      if (liveMetricsHistory.length > BODY_ANALYSIS_THRESHOLDS.performance.historyCapFrames) {
        liveMetricsHistory.shift();
      }
    }
  } catch (err) {
    console.error("Live frame analysis failed", err);
  } finally {
    isAnalyzingFrame = false;
    const elapsedMs = performance.now() - startedAt;
    const dynamicDelay = elapsedMs > LIVE_INTERVAL_MS
      ? Math.min(
        BODY_ANALYSIS_THRESHOLDS.performance.slowFrameDelayCapMs,
        Math.round(elapsedMs * BODY_ANALYSIS_THRESHOLDS.performance.slowFrameDelayFactor)
      )
      : LIVE_INTERVAL_MS;
    scheduleNextAnalysisTick(dynamicDelay);
  }
}

async function analyzeUploadedVideo() {
  // Analyze a prerecorded video by replaying it through the same live pipeline.
  if (!selectedVideoFile) {
    alert("Please choose a video file first.");
    return;
  }

  await ensureMediaPipeReady();

  stopContinuousAnalysis();
  stopCameraStream();
  await closeLiveBackendSession();

  const video = document.getElementById("camera-feed");
  const cameraBox = document.getElementById("camera-box");
  cameraBox.classList.remove("live-camera-mode");
  if (uploadedVideoUrl) {
    URL.revokeObjectURL(uploadedVideoUrl);
  }
  uploadedVideoUrl = URL.createObjectURL(selectedVideoFile);
  video.srcObject = null;
  video.src = uploadedVideoUrl;
  video.muted = true;
  video.loop = false;

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Could not load selected video."));
  });

  document.getElementById("camera-overlay").style.display = "none";
  document.getElementById("live-badge").style.display = "flex";
  document.getElementById("live-badge").innerHTML = `<span class="live-dot"></span> PLAYBACK`;
  document.getElementById("stop-camera-btn").style.display = "block";
  document.getElementById("body-feedback-placeholder").style.display = "flex";
  document.getElementById("body-feedback-placeholder").innerHTML =
    `<div class="placeholder-icon"><i class="fa-solid fa-film"></i></div><p>Playback analysis running. Wait for video to finish or stop manually for feedback.</p>`;
  document.getElementById("body-feedback-result").style.display = "none";

  liveSessionId = createSessionId();
  liveMetricsHistory = [];
  eyeContactScoredFrames = 0;
  eyeContactCenteredFrames = 0;
  latestCumulativeEyeContactScore = 100;
  analysisSource = "uploaded";

  await video.play();
  startContinuousAnalysis();
}

async function finalizeLiveSession() {
  // Send aggregated frame metrics to backend for final score/tips generation.
  setLoadingState("Generating final body language feedback...");

  try {
    const response = await fetch(`${FLASK_URL}/summarize-body-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ metrics: liveMetricsHistory })
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(data.error);
    }

    await showBodyFeedback(data, "live-session");
  } catch (err) {
    setLoadingState(`Feedback generation failed: ${err.message}`);
  } finally {
    liveMetricsHistory = [];
  }
}

document.getElementById("video-upload-input").addEventListener("change", (event) => {
  selectedVideoFile = event.target.files[0] || null;
  document.getElementById("video-file-name").textContent = selectedVideoFile
    ? `Selected: ${selectedVideoFile.name}`
    : "No file selected";
});

document.getElementById("analyze-upload-btn").addEventListener("click", async () => {
  try {
    await analyzeUploadedVideo();
  } catch (err) {
    setLoadingState(`Analysis failed: ${err.message}`);
  }
});

document.getElementById("camera-feed").addEventListener("ended", async () => {
  if (analysisSource !== "uploaded") return;

  stopContinuousAnalysis();
  document.getElementById("live-badge").style.display = "none";
  document.getElementById("stop-camera-btn").style.display = "none";
  analysisSource = "idle";

  if (liveMetricsHistory.length > 0) {
    await finalizeLiveSession();
  }

  await closeLiveBackendSession();
  stopUploadedVideoPlayback();
  document.getElementById("camera-overlay").style.display = "flex";
  resetMetrics();
});

// ── ANALYZE LIVE CAMERA FRAME ──
// ── SHOW BODY FEEDBACK ──
async function showBodyFeedback(data, source = "unknown") {
  // Render final feedback and persist session summary to Firestore.
  document.getElementById("body-feedback-placeholder").style.display = "none";
  document.getElementById("body-feedback-result").style.display = "block";
  document.getElementById("final-eye-contact-score").textContent = "—";

  if (data.averages) {
    updateLiveMetrics({
      shoulderAngle: data.averages.shoulder_angle !== undefined ? data.averages.shoulder_angle.toFixed(1) : "—",
      headTilt: data.averages.head_tilt !== undefined ? data.averages.head_tilt.toFixed(1) : "—",
      headMotion: data.averages.head_motion !== undefined ? data.averages.head_motion.toFixed(1) : "—",
      eyeContactScore: data.averages.eye_contact_score !== undefined ? `${Math.round(data.averages.eye_contact_score)}%` : "—",
      lookingAway: (data.top_issues || []).includes("Missing Eye Contact") ? "Yes" : "No"
    });

    document.getElementById("final-eye-contact-score").textContent =
      data.averages.eye_contact_score !== undefined
        ? `${Math.round(data.averages.eye_contact_score)}%`
        : "—";
  }

  const score = typeof data.score === "number" ? data.score : Number(data.score || 0);
  document.getElementById("body-score-badge").textContent = `${score}/10`;
  document.getElementById("body-feedback-text").textContent = data.feedback || "No feedback available.";

  if (data.tips && data.tips.length > 0) {
    const tipsList = document.getElementById("body-tips-list");
    tipsList.innerHTML = data.tips.map(t => `<li>${t}</li>`).join("");
  }

  // Save score to Firestore
  if (currentUser && !Number.isNaN(score)) {
    const now = new Date();
    const sessionId = createSessionId();
    const studentRef = doc(db, "students", currentUser.uid);
    const sessionRef = doc(db, "students", currentUser.uid, "sessions", sessionId);

    await setDoc(studentRef, {
      bodyScore: score,
      bodyFeedback: data.feedback || "",
      bodyLiveMetrics: data.live_metrics || {},
      bodyAverages: data.averages || {},
      bodyTopIssues: data.top_issues || [],
      updatedAt: now
    }, { merge: true });

    await setDoc(sessionRef, {
      sessionId,
      module: "posture",
      timestamp: now,
      source: data.source || source,
      score,
      feedback: data.feedback || "",
      liveMetrics: data.live_metrics || {},
      averages: data.averages || {},
      topIssues: data.top_issues || [],
      tips: data.tips || [],
      framesAnalyzed: data.frames_analyzed || 0,
      confidence: score
    });
  }
}