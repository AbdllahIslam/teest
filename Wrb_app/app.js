const videoElement = document.getElementById("localVideo");
const canvasElement = document.getElementById("canvas");
const canvasCtx = canvasElement.getContext("2d");

const cameraBtn = document.getElementById("cameraBtn");
const chatBox = document.getElementById("chatBox");
const statusElement = document.getElementById("status");
const connectionPill = document.getElementById("connectionPill");
const themeToggleBtn = document.getElementById("themeToggleBtn");

const BACKEND_ORIGIN = (() => {
  try {
    const currentUrl = new URL(window.location.href);
    const fromQuery = currentUrl.searchParams.get("backend");
    const fromStorage = localStorage.getItem("signai-backend-url");
    const resolved = fromQuery || fromStorage || window.location.origin;

    if (fromQuery) {
      localStorage.setItem("signai-backend-url", fromQuery);
    }

    return resolved.replace(/\/$/, "");
  } catch (error) {
    return window.location.origin;
  }
})();

// Same shape as the Python model
const SEQUENCE_LENGTH = 15;
const NUM_FEATURES = 225;

// Same camera style as the backend input
const CAMERA_WIDTH = 640;
const CAMERA_HEIGHT = 480;

const CONFIDENCE_THRESHOLD = 0.70;
const MINIMUM_PREDICTION_MARGIN = 0.10;
const REQUIRED_STABLE_PREDICTIONS = 3;
const PREDICTION_QUEUE_SIZE = 5;
const WORD_REPEAT_DELAY_MS = 1800;
const PREDICTION_INTERVAL_MS = 450;

let localStream = null;
let cameraStarted = false;
let cameraStartPromise = null;
let recognitionLoopRunning = false;
let frameBusy = false;
let isPredicting = false;
let lastPredictionTime = 0;
let lastAddedWord = "";
let lastAddedTime = 0;

let sequence = [];
let predictionQueue = [];
let pendingPrediction = {
  word: "",
  count: 0
};

let transcriptWords = [];
let latestDetectedWord = "";

let lastPredictionInfo = {
  top1: "--",
  top1Confidence: 0,
  top2: "--",
  top2Confidence: 0,
  top3: "--",
  top3Confidence: 0,
  margin: 0,
  accepted: false
};

const processCanvas = document.createElement("canvas");
processCanvas.width = CAMERA_WIDTH;
processCanvas.height = CAMERA_HEIGHT;
const processCtx = processCanvas.getContext("2d");

const THEME_STORAGE_KEY = "signai-theme";

function applyTheme(theme) {
  const isDark = theme === "dark";
  document.body.classList.toggle("theme-dark", isDark);

  if (themeToggleBtn) {
    themeToggleBtn.textContent = isDark ? "Light mode" : "Dark mode";
    themeToggleBtn.setAttribute("aria-pressed", String(isDark));
  }

  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (error) {
    // Ignore storage failures in private/incognito sessions.
  }
}

function initTheme() {
  let theme = "light";

  try {
    theme = localStorage.getItem(THEME_STORAGE_KEY) || "light";
  } catch (error) {
    theme = "light";
  }

  if (theme !== "light" && theme !== "dark") {
    theme = "light";
  }

  applyTheme(theme);
}

initTheme();

if (themeToggleBtn) {
  themeToggleBtn.addEventListener("click", () => {
    const nextTheme = document.body.classList.contains("theme-dark") ? "light" : "dark";
    applyTheme(nextTheme);
  });
}

function updateConnectionPill(text) {
  if (connectionPill) {
    connectionPill.textContent = text;
  }
}

function renderTranscript() {
  if (!chatBox) {
    return;
  }

  chatBox.innerHTML = "";

  if (transcriptWords.length === 0) {
    const placeholder = document.createElement("div");
    placeholder.className = "chat-message";
    placeholder.textContent = "Recognized words will appear here.";
    chatBox.appendChild(placeholder);
    return;
  }

  transcriptWords.forEach((word) => {
    const message = document.createElement("div");
    message.className = "chat-message";
    message.textContent = word;
    chatBox.appendChild(message);
  });

  chatBox.scrollTop = chatBox.scrollHeight;
}

renderTranscript();
updateDetectedWord("");

function updateDetectedWord(word, broadcast = false) {
  latestDetectedWord = word || "";

  if (typeof window.setLocalDetectedWord === "function") {
    window.setLocalDetectedWord(latestDetectedWord);
  }

  if (broadcast && typeof window.broadcastDetectedWord === "function") {
    window.broadcastDetectedWord(latestDetectedWord);
  }
}

function showStatus(message) {
  if (statusElement) {
    statusElement.textContent = message;
  }
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function prepareProcessingFrame() {
  if (!videoElement || videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return false;
  }

  processCtx.save();
  processCtx.clearRect(0, 0, CAMERA_WIDTH, CAMERA_HEIGHT);
  processCtx.translate(CAMERA_WIDTH, 0);
  processCtx.scale(-1, 1);
  processCtx.drawImage(videoElement, 0, 0, CAMERA_WIDTH, CAMERA_HEIGHT);
  processCtx.restore();
  return true;
}

function flattenLandmarks(landmarks, landmarkCount) {
  const output = [];

  if (!landmarks) {
    return new Array(landmarkCount * 3).fill(0);
  }

  for (let i = 0; i < landmarkCount; i++) {
    const point = landmarks[i];

    if (!point) {
      output.push(0, 0, 0);
    } else {
      output.push(point.x || 0, point.y || 0, point.z || 0);
    }
  }

  return output;
}

function getHandLabel(handedness) {
  if (!handedness) {
    return "";
  }

  if (handedness.label) {
    return handedness.label;
  }

  if (handedness.classification && handedness.classification[0] && handedness.classification[0].label) {
    return handedness.classification[0].label;
  }

  return "";
}

function extractKeypoints(poseResults, handsResults) {
  const poseKp = flattenLandmarks(poseResults.poseLandmarks, 33);
  let leftHandKp = new Array(21 * 3).fill(0);
  let rightHandKp = new Array(21 * 3).fill(0);

  if (handsResults.multiHandLandmarks && handsResults.multiHandLandmarks.length > 0) {
    for (let i = 0; i < handsResults.multiHandLandmarks.length; i++) {
      const handLandmarks = handsResults.multiHandLandmarks[i];
      const handedness = handsResults.multiHandedness ? handsResults.multiHandedness[i] : null;
      const label = getHandLabel(handedness);
      const kp = flattenLandmarks(handLandmarks, 21);

      if (label === "Left") {
        leftHandKp = kp;
      } else {
        rightHandKp = kp;
      }
    }
  }

  return [...poseKp, ...leftHandKp, ...rightHandKp];
}

let poseResolve = null;
let handsResolve = null;

const pose = new Pose({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`
});

pose.setOptions({
  staticImageMode: false,
  modelComplexity: 0,
  smoothLandmarks: true,
  enableSegmentation: false,
  smoothSegmentation: false,
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5
});

pose.onResults((results) => {
  if (poseResolve) {
    poseResolve(results);
    poseResolve = null;
  }
});

const hands = new Hands({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
});

hands.setOptions({
  staticImageMode: false,
  maxNumHands: 2,
  modelComplexity: 0,
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5
});

hands.onResults((results) => {
  if (handsResolve) {
    handsResolve(results);
    handsResolve = null;
  }
});

function processPose(image) {
  return new Promise((resolve) => {
    poseResolve = resolve;
    pose.send({ image });
  });
}

function processHands(image) {
  return new Promise((resolve) => {
    handsResolve = resolve;
    hands.send({ image });
  });
}

function drawHudBackground() {
  const barHeight = 98;
  const gradient = canvasCtx.createLinearGradient(0, 0, CAMERA_WIDTH, 0);
  gradient.addColorStop(0, "rgba(2, 6, 23, 0.94)");
  gradient.addColorStop(0.5, "rgba(6, 78, 59, 0.88)");
  gradient.addColorStop(1, "rgba(2, 6, 23, 0.94)");

  canvasCtx.save();
  canvasCtx.fillStyle = gradient;
  canvasCtx.fillRect(0, 0, CAMERA_WIDTH, barHeight);
  canvasCtx.strokeStyle = "rgba(16, 185, 129, 0.9)";
  canvasCtx.lineWidth = 2;
  canvasCtx.beginPath();
  canvasCtx.moveTo(0, barHeight);
  canvasCtx.lineTo(CAMERA_WIDTH, barHeight);
  canvasCtx.stroke();
  canvasCtx.restore();
}

function drawTopBar() {
  drawHudBackground();

  const top1Percent = Math.round(lastPredictionInfo.top1Confidence * 100);
  const top2Percent = Math.round(lastPredictionInfo.top2Confidence * 100);
  const marginPercent = Math.round(lastPredictionInfo.margin * 100);

  canvasCtx.save();
  canvasCtx.font = "bold 20px Arial";
  canvasCtx.fillStyle = lastPredictionInfo.accepted ? "#34d399" : "#fbbf24";
  canvasCtx.fillText(
    lastPredictionInfo.accepted
      ? `1st: ${lastPredictionInfo.top1} (${top1Percent}%)`
      : `Not sure (${top1Percent}%)`,
    22,
    36
  );

  canvasCtx.font = "15px Arial";
  canvasCtx.fillStyle = "#a7f3d0";
  canvasCtx.fillText(`2nd: ${lastPredictionInfo.top2} (${top2Percent}%)`, 22, 64);

  canvasCtx.fillStyle = "#ffffff";
  canvasCtx.fillText(`Difference: ${marginPercent}%`, 240, 64);

  const meterWidth = 220;
  const filledWidth = Math.max(0, Math.min(meterWidth, lastPredictionInfo.top1Confidence * meterWidth));
  drawRoundedRect(canvasCtx, 22, 76, meterWidth, 8, 6);
  canvasCtx.fillStyle = "rgba(255, 255, 255, 0.18)";
  canvasCtx.fill();
  drawRoundedRect(canvasCtx, 22, 76, filledWidth, 8, 6);
  canvasCtx.fillStyle = "#34d399";
  canvasCtx.fill();

  canvasCtx.font = "bold 12px Arial";
  canvasCtx.fillStyle = "#d1fae5";
  canvasCtx.fillText("POSE + HANDS + LSTM", CAMERA_WIDTH - 162, 24);
  canvasCtx.restore();
}

function drawCornerFrame(x, y, width, height) {
  const length = 24;
  canvasCtx.save();
  canvasCtx.strokeStyle = "#34d399";
  canvasCtx.lineWidth = 3;
  canvasCtx.lineCap = "round";
  canvasCtx.beginPath();

  canvasCtx.moveTo(x, y + length);
  canvasCtx.lineTo(x, y);
  canvasCtx.lineTo(x + length, y);

  canvasCtx.moveTo(x + width - length, y);
  canvasCtx.lineTo(x + width, y);
  canvasCtx.lineTo(x + width, y + length);

  canvasCtx.moveTo(x + width, y + height - length);
  canvasCtx.lineTo(x + width, y + height);
  canvasCtx.lineTo(x + width - length, y + height);

  canvasCtx.moveTo(x + length, y + height);
  canvasCtx.lineTo(x, y + height);
  canvasCtx.lineTo(x, y + height - length);

  canvasCtx.stroke();
  canvasCtx.restore();
}

function drawHandBox(handLandmarks) {
  const xs = handLandmarks.map((lm) => lm.x * CAMERA_WIDTH);
  const ys = handLandmarks.map((lm) => lm.y * CAMERA_HEIGHT);

  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const boxWidth = xMax - xMin;
  const boxHeight = yMax - yMin;

  if (boxWidth <= 0 || boxHeight <= 0) {
    return;
  }

  const size = Math.max(boxWidth, boxHeight);
  const cx = (xMin + xMax) / 2;
  const cy = (yMin + yMax) / 2;
  const half = size / 2 + 18;

  const x1 = Math.max(0, cx - half);
  const y1 = Math.max(0, cy - half);
  const x2 = Math.min(CAMERA_WIDTH, cx + half);
  const y2 = Math.min(CAMERA_HEIGHT, cy + half);

  canvasCtx.save();
  canvasCtx.shadowColor = "rgba(52, 211, 153, 0.9)";
  canvasCtx.shadowBlur = 18;
  canvasCtx.strokeStyle = "rgba(52, 211, 153, 0.38)";
  canvasCtx.lineWidth = 1;
  drawRoundedRect(canvasCtx, x1, y1, x2 - x1, y2 - y1, 16);
  canvasCtx.stroke();
  drawCornerFrame(x1, y1, x2 - x1, y2 - y1);
  canvasCtx.restore();
}

function drawDisplayFrame(handsResults) {
  canvasElement.width = CAMERA_WIDTH;
  canvasElement.height = CAMERA_HEIGHT;
  canvasCtx.clearRect(0, 0, CAMERA_WIDTH, CAMERA_HEIGHT);
  canvasCtx.drawImage(processCanvas, 0, 0, CAMERA_WIDTH, CAMERA_HEIGHT);

  const vignette = canvasCtx.createRadialGradient(
    CAMERA_WIDTH / 2,
    CAMERA_HEIGHT / 2,
    90,
    CAMERA_WIDTH / 2,
    CAMERA_HEIGHT / 2,
    CAMERA_WIDTH / 1.05
  );
  vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
  vignette.addColorStop(1, "rgba(0, 0, 0, 0.34)");
  canvasCtx.fillStyle = vignette;
  canvasCtx.fillRect(0, 0, CAMERA_WIDTH, CAMERA_HEIGHT);

  if (handsResults.multiHandLandmarks && handsResults.multiHandLandmarks.length > 0) {
    handsResults.multiHandLandmarks.forEach((handLandmarks) => {
      drawConnectors(canvasCtx, handLandmarks, HAND_CONNECTIONS, {
        color: "#facc15",
        lineWidth: 1
      });

      drawLandmarks(canvasCtx, handLandmarks, {
        color: "#00ffff",
        fillColor: "#00ffff",
        radius: 2,
        lineWidth: 1
      });

      drawHandBox(handLandmarks);
    });
  }
}

function smoothPrediction(data) {
  predictionQueue.push({
    word: data.word,
    confidence: data.confidence,
    top2Word: data.top2_word,
    top2Confidence: data.top2_confidence,
    top3Word: data.top3_word,
    top3Confidence: data.top3_confidence,
    margin: data.margin
  });

  if (predictionQueue.length > PREDICTION_QUEUE_SIZE) {
    predictionQueue.shift();
  }

  const counts = {};
  predictionQueue.forEach((item) => {
    counts[item.word] = (counts[item.word] || 0) + 1;
  });

  let bestWord = data.word;
  let bestCount = 0;

  Object.keys(counts).forEach((word) => {
    if (counts[word] > bestCount) {
      bestWord = word;
      bestCount = counts[word];
    }
  });

  const matching = predictionQueue.filter((item) => item.word === bestWord);
  const latest = matching[matching.length - 1];
  const avgConfidence = matching.reduce((sum, item) => sum + item.confidence, 0) / matching.length;
  const avgMargin = matching.reduce((sum, item) => sum + item.margin, 0) / matching.length;

  return {
    word: bestWord,
    confidence: avgConfidence,
    top2Word: latest.top2Word,
    top2Confidence: latest.top2Confidence,
    top3Word: latest.top3Word,
    top3Confidence: latest.top3Confidence,
    margin: avgMargin
  };
}

function isPredictionSure(prediction) {
  return (
    prediction.confidence >= CONFIDENCE_THRESHOLD &&
    prediction.margin >= MINIMUM_PREDICTION_MARGIN
  );
}

function confirmStablePrediction(word) {
  if (pendingPrediction.word === word) {
    pendingPrediction.count += 1;
  } else {
    pendingPrediction.word = word;
    pendingPrediction.count = 1;
  }

  return pendingPrediction.count >= REQUIRED_STABLE_PREDICTIONS;
}

function resetPredictionStability() {
  pendingPrediction.word = "";
  pendingPrediction.count = 0;
}

function addWordToSentence(word) {
  const now = Date.now();

  if (word === lastAddedWord && now - lastAddedTime < WORD_REPEAT_DELAY_MS) {
    return;
  }

  lastAddedWord = word;
  lastAddedTime = now;
  updateDetectedWord(word, true);
  transcriptWords.push(word);
  renderTranscript();
}

async function sendPrediction() {
  if (isPredicting) {
    return;
  }

  const now = Date.now();
  if (now - lastPredictionTime < PREDICTION_INTERVAL_MS) {
    return;
  }

  lastPredictionTime = now;
  isPredicting = true;

  try {
    const response = await fetch(`${BACKEND_ORIGIN}/predict`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        sequence
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Prediction error:", data);
      showStatus(`Backend error: ${data.error}. Received ${data.received}, expected ${data.expected}.`);
      return;
    }

    const smoothed = smoothPrediction(data);
    const sure = isPredictionSure(smoothed);
    updateDetectedWord(smoothed.word);

    lastPredictionInfo = {
      top1: smoothed.word,
      top1Confidence: smoothed.confidence,
      top2: smoothed.top2Word,
      top2Confidence: smoothed.top2Confidence,
      top3: smoothed.top3Word,
      top3Confidence: smoothed.top3Confidence,
      margin: smoothed.margin,
      accepted: sure
    };

    const confidencePercent = Math.round(smoothed.confidence * 100);
    const marginPercent = Math.round(smoothed.margin * 100);

    if (sure) {
      const stable = confirmStablePrediction(smoothed.word);

      showStatus(
        `Checking: ${smoothed.word} (${pendingPrediction.count}/${REQUIRED_STABLE_PREDICTIONS}) | Confidence: ${confidencePercent}% | Difference: ${marginPercent}%`
      );

      if (stable) {
        addWordToSentence(smoothed.word);
        resetPredictionStability();
        showStatus(`Recognized: ${smoothed.word} | Confidence: ${confidencePercent}%`);
      }
    } else {
      resetPredictionStability();
      showStatus(
        `Not sure: ${smoothed.word} vs ${smoothed.top2Word} | Confidence: ${confidencePercent}% | Difference: ${marginPercent}%`
      );
    }
  } catch (error) {
    console.error("Server error:", error);
    showStatus("Could not connect to Flask server.");
  } finally {
    isPredicting = false;
  }
}

async function processCurrentFrame() {
  if (!prepareProcessingFrame()) {
    return;
  }

  const poseResults = await processPose(processCanvas);
  const handsResults = await processHands(processCanvas);
  drawDisplayFrame(handsResults);

  const hasHand = handsResults.multiHandLandmarks && handsResults.multiHandLandmarks.length > 0;

  if (!hasHand) {
    sequence = [];
    predictionQueue = [];
    resetPredictionStability();
    lastPredictionInfo.accepted = false;
    lastPredictionInfo.top1Confidence = 0;
    lastPredictionInfo.top2Confidence = 0;
    lastPredictionInfo.top3Confidence = 0;
    lastPredictionInfo.margin = 0;
    updateDetectedWord("");
    showStatus("Show your hand clearly inside the camera frame.");
    return;
  }

  const keypoints = extractKeypoints(poseResults, handsResults);

  if (keypoints.length !== NUM_FEATURES) {
    showStatus(`Wrong feature length. Got ${keypoints.length}, expected ${NUM_FEATURES}.`);
    return;
  }

  sequence.push(keypoints);

  if (sequence.length > SEQUENCE_LENGTH) {
    sequence.shift();
  }

  if (sequence.length < SEQUENCE_LENGTH) {
    showStatus(`Collecting frames: ${sequence.length}/${SEQUENCE_LENGTH}`);
    return;
  }

  sendPrediction();
}

function recognitionLoop() {
  if (!cameraStarted) {
    recognitionLoopRunning = false;
    frameBusy = false;
    return;
  }

  if (!frameBusy) {
    frameBusy = true;
    processCurrentFrame()
      .catch((error) => {
        console.error("Frame processing error:", error);
      })
      .finally(() => {
        frameBusy = false;
      });
  }

  requestAnimationFrame(recognitionLoop);
}

async function startCamera() {
  if (cameraStarted) {
    return localStream;
  }

  if (cameraStartPromise) {
    return cameraStartPromise;
  }

  cameraStartPromise = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: CAMERA_WIDTH },
        height: { ideal: CAMERA_HEIGHT },
        facingMode: "user"
      },
      audio: true
    });

    localStream = stream;
    videoElement.srcObject = stream;
    await videoElement.play().catch(() => {});

    cameraStarted = true;
    cameraBtn.textContent = "Turn camera off";
    if (typeof window.setLocalStatus === "function") {
      window.setLocalStatus("Camera on");
    }
    showStatus("Camera started. Join a room to meet with others.");

    if (!recognitionLoopRunning) {
      recognitionLoopRunning = true;
      requestAnimationFrame(recognitionLoop);
    }

    return stream;
  })();

  try {
    return await cameraStartPromise;
  } finally {
    cameraStartPromise = null;
  }
}

function stopCamera() {
  if (!cameraStarted) {
    return;
  }

  cameraStarted = false;
  cameraBtn.textContent = "Turn camera on";
  showStatus("Camera stopped.");

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }

  videoElement.srcObject = null;
  sequence = [];
  predictionQueue = [];
  resetPredictionStability();
  updateDetectedWord("");
  if (typeof window.setLocalStatus === "function") {
    window.setLocalStatus("Camera off");
  }
  lastPredictionInfo = {
    top1: "--",
    top1Confidence: 0,
    top2: "--",
    top2Confidence: 0,
    top3: "--",
    top3Confidence: 0,
    margin: 0,
    accepted: false
  };

  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
}

cameraBtn.addEventListener("click", async () => {
  try {
    if (cameraStarted) {
      stopCamera();
    } else {
      await startCamera();
    }
  } catch (error) {
    console.error("Camera error:", error);
    showStatus("Camera failed. Allow camera permission and use localhost.");
  }
});

window.startCamera = startCamera;
window.stopCamera = stopCamera;
window.getLocalStream = () => localStream;
window.updateConnectionPill = updateConnectionPill;

window.addEventListener("beforeunload", () => {
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
  }
});
