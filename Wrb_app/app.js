// ==========================================================================
// CONSTANTS & STATE
// ==========================================================================

const SEQUENCE_LENGTH = 15;
const NUM_FEATURES = 225;
const CAMERA_WIDTH = 640;
const CAMERA_HEIGHT = 480;

// Model confidence thresholds (match original values)
const CONFIDENCE_THRESHOLD = 0.70;
const MINIMUM_PREDICTION_MARGIN = 0.10;

// Model stability parameters
const REQUIRED_STABLE_PREDICTIONS = 3;
const PREDICTION_QUEUE_SIZE = 5;
const WORD_REPEAT_DELAY_MS = 1800;
const PREDICTION_INTERVAL_MS = 250;

// App navigation state
let currentScreen = "lobby"; // "lobby" or "meeting"

// Room connection details
let roomId = "";
let userId = "";
let username = "";
let lastEventId = 0;
let reconnectEventFloor = 0; // discard events older than this after a reconnect

// Media streams
let localStream = null;
let lobbyStream = null;
let cameraOn = true;
let micOn = true;
let recognitionActive = false;

// MediaPipe state
let poseResolve = null;
let handsResolve = null;
let frameLoopActive = false;

// Model prediction state
let sequence = [];
let isPredicting = false;
let lastPredictionTime = 0;
let lastAddedWord = "";
let lastAddedTime = 0;
let predictionQueue = [];
let pendingPrediction = { word: "", count: 0 };

// Peer connections (WebRTC Mesh)
const peerConnections = {}; // targetUserId -> RTCPeerConnection
const pendingOffers = {}; // targetUserId -> true (tracks who we sent offers to)
const connectionAttemptCounts = {}; // targetUserId -> number (persists across reconnect calls)

// Speech bubble timers
const bubbleTimers = {}; // userId -> setTimeout ID

// Timers for polling and heartbeats
let pollInterval = null;
let heartbeatInterval = null;
let pollFailureCount = 0;

// Reconnect state
let serverDead = false;          // true while we're getting 404/502
let reconnectTimer = null;
let reconnectAttempt = 0;
const MAX_RECONNECT_DELAY_MS = 15000;
const BASE_RECONNECT_DELAY_MS = 2000;

// ==========================================================================
// DOM ELEMENTS
// ==========================================================================

const body = document.body;
const lobbyScreen = document.getElementById("lobby-screen");
const meetingScreen = document.getElementById("meeting-screen");

// Lobby inputs & buttons
const usernameInput = document.getElementById("usernameInput");
const roomInput = document.getElementById("roomInput");
const randomRoomBtn = document.getElementById("random-room-btn");
const joinMeetingBtn = document.getElementById("join-meeting-btn");
const lobbyWebcam = document.getElementById("lobbyWebcam");
const lobbyCamToggle = document.getElementById("lobbyCamToggle");
const lobbyMicToggle = document.getElementById("lobbyMicToggle");

// Meeting layout elements
const videoGrid = document.getElementById("video-grid");
const webcamElement = document.getElementById("webcam");
const canvasElement = document.getElementById("canvas");
const canvasCtx = canvasElement ? canvasElement.getContext("2d") : null;
const roomBadge = document.getElementById("room-badge");
const displayRoomId = document.getElementById("display-room-id");
const copyRoomBtn = document.getElementById("copy-room-btn");
const roomHeaderStatus = document.getElementById("room-header-status");
const themeToggleBtn = document.getElementById("theme-toggle-btn");

// Sidebar elements
const sidebar = document.getElementById("sidebar");
const sidebarToggleBtn = document.getElementById("sidebar-toggle-btn");
const tabChat = document.getElementById("tab-chat");
const tabVocab = document.getElementById("tab-vocab");
const panelChat = document.getElementById("panel-chat");
const panelVocab = document.getElementById("panel-vocab");
const chatBox = document.getElementById("chat-box");
const chatInput = document.getElementById("chat-input");
const sendChatBtn = document.getElementById("send-chat-btn");

// Control bar elements
const micToggleBtn = document.getElementById("mic-toggle-btn");
const cameraToggleBtn = document.getElementById("camera-toggle-btn");
const recognitionToggleBtn = document.getElementById("recognition-toggle-btn");
const leaveBtn = document.getElementById("leave-btn");
const recognitionStatusText = document.getElementById("recognition-status");

// Hidden canvas for processing (mimics Python cv2.flip(frame, 1))
const processCanvas = document.createElement("canvas");
processCanvas.width = CAMERA_WIDTH;
processCanvas.height = CAMERA_HEIGHT;
const processCtx = processCanvas.getContext("2d");

// ==========================================================================
// INITIALIZATION & THEME SWITCHER
// ==========================================================================

document.addEventListener("DOMContentLoaded", () => {
  // Restore theme preference
  const savedTheme = localStorage.getItem("theme") || "dark";
  body.setAttribute("data-theme", savedTheme);
  updateThemeIcon(savedTheme);

  // Initialize inputs
  generateRandomRoomId();
  setupEventListeners();

  // Try to start preview camera
  startLobbyPreview();
});

function updateThemeIcon(theme) {
  if (themeToggleBtn) {
    const icon = themeToggleBtn.querySelector(".theme-icon");
    if (icon) {
      icon.textContent = theme === "light" ? "🌙" : "☀️";
    }
  }
}

function toggleTheme() {
  const currentTheme = body.getAttribute("data-theme");
  const newTheme = currentTheme === "light" ? "dark" : "light";
  body.setAttribute("data-theme", newTheme);
  localStorage.setItem("theme", newTheme);
  updateThemeIcon(newTheme);
}

// Generate random room code like abc-def-ghi
function generateRandomRoomId() {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  const segment = () => Array.from({ length: 3 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  const code = `${segment()}-${segment()}-${segment()}`;
  if (roomInput) {
    roomInput.value = code;
  }
}

// ==========================================================================
// ==========================================================================
// CAMERA & MIC CONTROLS (LOBBY & GENERAL)
// ==========================================================================

async function startLobbyPreview() {
  // Stop any existing lobby stream first
  if (lobbyStream) {
    lobbyStream.getTracks().forEach(t => t.stop());
    lobbyStream = null;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: CAMERA_WIDTH }, height: { ideal: CAMERA_HEIGHT } },
      audio: true
    });

    lobbyStream = stream;

    if (lobbyWebcam) {
      lobbyWebcam.srcObject = stream;
      // muted + autoplay allows browsers to play without gesture requirement
      lobbyWebcam.muted = true;
      try {
        await lobbyWebcam.play();
      } catch (playErr) {
        console.warn("Lobby video autoplay blocked, will play on interaction:", playErr);
      }
    }

    // Populate camera dropdown after stream is open (labels become available)
    populateCameraList();

  } catch (err) {
    console.error("getUserMedia failed for lobby:", err);
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      alert("Camera/microphone permission denied. Please allow access in your browser settings and reload the page.");
    } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
      alert("No camera or microphone found. Please connect a device and try again.");
    } else {
      alert(`Could not open camera: ${err.message}`);
    }
  }
}

function stopLobbyPreview() {
  if (lobbyStream) {
    lobbyStream.getTracks().forEach(track => track.stop());
    lobbyStream = null;
  }
  if (lobbyWebcam) {
    lobbyWebcam.srcObject = null;
  }
}

function toggleLobbyCam() {
  if (!lobbyStream) return;
  cameraOn = !cameraOn;
  lobbyStream.getVideoTracks().forEach(track => track.enabled = cameraOn);
  lobbyCamToggle.classList.toggle("muted", !cameraOn);
  lobbyCamToggle.textContent = cameraOn ? "📹" : "❌";
}

function toggleLobbyMic() {
  if (!lobbyStream) return;
  micOn = !micOn;
  lobbyStream.getAudioTracks().forEach(track => track.enabled = micOn);
  lobbyMicToggle.classList.toggle("muted", !micOn);
  lobbyMicToggle.textContent = micOn ? "🎙️" : "❌";
}

async function populateCameraList() {
  try {
    const cameraSelect = document.getElementById("cameraSelect");
    if (!cameraSelect) return;

    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === "videoinput");

    const prev = cameraSelect.value;
    cameraSelect.innerHTML = "";
    videoDevices.forEach((device, i) => {
      const opt = document.createElement("option");
      opt.value = device.deviceId;
      opt.textContent = device.label || `Camera ${i + 1}`;
      cameraSelect.appendChild(opt);
    });

    // Restore previous selection if still available
    if (prev && Array.from(cameraSelect.options).some(o => o.value === prev)) {
      cameraSelect.value = prev;
    }

    cameraSelect.onchange = () => {
      stopLobbyPreview();
      startLobbyPreview();
    };
  } catch (e) {
    console.warn("Could not enumerate devices:", e);
  }
}

async function startMeetingStream() {
  try {
    // Open a fresh stream for the meeting (lobby stream is already stopped)
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: CAMERA_WIDTH }, height: { ideal: CAMERA_HEIGHT } },
      audio: true
    });
    localStream = stream;

    if (webcamElement) {
      webcamElement.srcObject = null; // clear old stream first
      webcamElement.srcObject = localStream;
      webcamElement.muted = true; // mute own preview (no echo)
      // Play via event listener for cross-browser compatibility
      await new Promise((resolve) => {
        webcamElement.onloadedmetadata = async () => {
          try {
            await webcamElement.play();
            resolve();
          } catch (e) {
            console.warn("Meeting video play failed:", e);
            resolve(); // don't block joining on play failure
          }
        };
        // Safety timeout in case onloadedmetadata never fires
        setTimeout(resolve, 3000);
      });
    }

    // Apply mic/cam preferences user set in lobby
    localStream.getVideoTracks().forEach(track => track.enabled = cameraOn);
    localStream.getAudioTracks().forEach(track => track.enabled = micOn);

    // Reflect state in UI
    const localCard = document.getElementById("local-video-card");
    if (localCard) localCard.classList.toggle("camera-off", !cameraOn);
    const localMicIndicator = document.getElementById("local-mic-indicator");
    if (localMicIndicator) localMicIndicator.classList.toggle("hidden", micOn);

    // Add local tracks to any already pending peer connections
    Object.values(peerConnections).forEach(pc => {
      localStream.getTracks().forEach(track => {
        const senders = pc.getSenders();
        const alreadyAdded = senders.some(s => s.track === track);
        if (!alreadyAdded) pc.addTrack(track, localStream);
      });
    });

  } catch (err) {
    console.error("Error starting meeting stream:", err);
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      alert("Camera/microphone permission denied. Please allow access and try rejoining.");
    } else {
      alert(`Could not open camera for meeting: ${err.message}`);
    }
  }
}

// ===========================================================================
// MEETING LIFE CYCLE: JOIN, HEARTBEAT, LEAVE
// ==========================================================================

async function joinMeeting() {
  const name = usernameInput.value.trim();
  const room = roomInput.value.trim();

  if (!name) {
    alert("Please enter your name");
    return;
  }
  if (!room) {
    alert("Please enter a room code");
    return;
  }

  username = name;
  roomId = room;

  try {
    const response = await fetch("/api/rooms/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room_id: roomId, username: username })
    });

    if (!response.ok) {
      const errData = await response.json();
      alert(`Join error: ${errData.error}`);
      return;
    }

    const data = await response.json();
    userId = data.user_id;

    // Transition Screen
    stopLobbyPreview();
    lobbyScreen.classList.remove("active");
    meetingScreen.classList.add("active");
    currentScreen = "meeting";

    // Set UI Header Info
    roomHeaderStatus.textContent = "Connected";
    displayRoomId.textContent = roomId;
    roomBadge.classList.remove("hidden");

    // Start local camera/mic stream FIRST so localStream is ready before peer connections are created
    await startMeetingStream();

    // Connect WebRTC to all existing participants in the room
    // NEW JOINER is responsible for creating offers to existing participants
    data.participants.forEach(p => {
      initiatePeerConnection(p.id, p.name, true);
    });

    // Configure Button Classes
    cameraToggleBtn.classList.toggle("muted", !cameraOn);
    micToggleBtn.classList.toggle("muted", !micOn);

    // Initial sync and start timers
    lastEventId = 0;
    startSyncIntervals();

    // Start Landmark Frame Processing Loop
    frameLoopActive = true;
    requestAnimationFrame(frameLoop);

    // Turn on Sign Language recognition by default
    toggleSignRecognition(true);

    addSystemMessage("You joined the meeting.");
  } catch (err) {
    console.error("Connection error:", err);
    alert("Could not connect to the room server.");
  }
}

async function leaveMeeting() {
  // Stop frame loops
  frameLoopActive = false;
  toggleSignRecognition(false);
  stopSyncIntervals();

  // Cancel any pending reconnect so an intentional leave never auto-rejoins
  serverDead = false;
  reconnectAttempt = 0;
  reconnectInProgress = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  // Notify server
  if (roomId && userId) {
    try {
      await fetch(`/api/rooms/${roomId}/leave`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId })
      });
    } catch (err) {
      console.error("Error sending leave event:", err);
    }
  }

  // Close all WebRTC peers
  Object.keys(peerConnections).forEach(pid => {
    peerConnections[pid].close();
    delete peerConnections[pid];
  });

  // Clear ICE candidate buffers
  Object.keys(iceCandidateBuffers).forEach(pid => {
    delete iceCandidateBuffers[pid];
  });

  // Remove remote video elements
  const cards = videoGrid.querySelectorAll(".video-card.remote");
  cards.forEach(c => c.remove());

  // Clean local streams and release camera
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (webcamElement) {
    webcamElement.srcObject = null;
  }

  // Reset local state
  roomId = "";
  userId = "";
  username = "";
  lastEventId = 0;
  peerConnections;
  sequence = [];
  predictionQueue = [];

  // Reset UI View
  roomBadge.classList.add("hidden");
  roomHeaderStatus.textContent = "Lobby";
  meetingScreen.classList.remove("active");
  lobbyScreen.classList.add("active");
  currentScreen = "lobby";

  // Re-enable lobby camera preview
  cameraOn = true;
  micOn = true;
  lobbyCamToggle.classList.remove("muted");
  lobbyCamToggle.textContent = "📹";
  lobbyMicToggle.classList.remove("muted");
  lobbyMicToggle.textContent = "🎙️";
  startLobbyPreview();
}

// Tracks whether a poll fetch is already in-flight so we never run two concurrently
let pollInFlight = false;
// Current adaptive poll delay (ms). Speeds up when healthy, slows down under stress.
let currentPollDelay = 300;
const POLL_DELAY_MIN = 200;
const POLL_DELAY_MAX = 3000;

function startSyncIntervals() {
  stopSyncIntervals(); // clear any existing timers first
  currentPollDelay = POLL_DELAY_MIN;
  schedulePoll();
  heartbeatInterval = setInterval(sendHeartbeat, 4000);
}

function stopSyncIntervals() {
  if (pollInterval) { clearTimeout(pollInterval); pollInterval = null; }
  clearInterval(heartbeatInterval);
  pollInFlight = false;
}

// Schedule the next poll using a timeout (not interval) so:
//  1. Two polls can never overlap (no concurrent fetches)
//  2. The delay can adapt based on network health
function schedulePoll() {
  if (pollInterval) clearTimeout(pollInterval);
  pollInterval = setTimeout(async () => {
    if (!roomId || !userId || serverDead) return;
    if (!pollInFlight) {
      pollInFlight = true;
      try { await pollEvents(); } finally { pollInFlight = false; }
    }
    if (!serverDead) schedulePoll(); // reschedule only if still alive
  }, currentPollDelay);
}

async function sendHeartbeat() {
  if (!roomId || !userId) return;
  try {
    await fetch(`/api/rooms/${roomId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId })
    });
  } catch (err) {
    console.warn("Heartbeat error (non-critical):", err.message);
  }
}

// Broadcast client action/media changes to room
async function sendEvent(eventType, eventData = {}, recipient = null) {
  if (!roomId || !userId) return;
  try {
    const response = await fetch(`/api/rooms/${roomId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        event_type: eventType,
        data: eventData,
        recipient: recipient
      })
    });
    if (!response.ok && response.status >= 500) {
      console.error(`Server error (${response.status}) sending ${eventType} event`);
    }
  } catch (err) {
    console.warn(`Network error sending ${eventType} event:`, err.message);
  }
}

// ==========================================================================
// HTTP POLLING EVENT SYNCER
// ==========================================================================

async function pollEvents() {
  if (!roomId || !userId || serverDead) return;

  try {
    const response = await fetch(
      `/api/rooms/${roomId}/events?user_id=${userId}&last_event_id=${lastEventId}`,
      { signal: AbortSignal.timeout(4000) }
    );

    if (response.status === 404 || response.status === 410) {
      handleServerDead("Server restarted – reconnecting…");
      return;
    }

    if (response.status === 502 || response.status === 503 || response.status === 504) {
      pollFailureCount++;
      // Slow down before declaring dead – back off the poll rate first
      currentPollDelay = Math.min(currentPollDelay * 2, POLL_DELAY_MAX);
      if (pollFailureCount >= 3) handleServerDead("Server unavailable – reconnecting…");
      return;
    }

    if (!response.ok) {
      pollFailureCount++;
      currentPollDelay = Math.min(currentPollDelay * 1.5, POLL_DELAY_MAX);
      return;
    }

    // ── Success: restore fast polling, reset failure counter ─────────────────
    pollFailureCount = 0;
    currentPollDelay = POLL_DELAY_MIN;

    const data = await response.json();
    if (data.events && data.events.length > 0) {
      const fresh = data.events.filter(e => e.id > reconnectEventFloor);
      if (fresh.length > 0) {
        fresh.forEach(event => {
          handleReceivedEvent(event);
          lastEventId = Math.max(lastEventId, event.id);
        });
      }
      data.events.forEach(e => { lastEventId = Math.max(lastEventId, e.id); });
      reconnectEventFloor = 0;
    }
  } catch (err) {
    pollFailureCount++;
    const isTimeout = err.name === "AbortError" || err.name === "TimeoutError";
    // Back off poll rate on timeouts to avoid amplifying a congested network
    currentPollDelay = Math.min(currentPollDelay * (isTimeout ? 2 : 1.5), POLL_DELAY_MAX);
    const threshold = isTimeout ? 5 : 3;
    if (pollFailureCount >= threshold) handleServerDead("Connection lost – reconnecting…");
  }
}

/**
 * Called when the server is unreachable or room is gone.
 * Closes dead peer connections, shows UI status, and schedules an
 * exponential-backoff rejoin attempt.
 */
function handleServerDead(statusMessage) {
  if (serverDead) return;  // already handling – ignore duplicate triggers from in-flight polls
  serverDead = true;
  pollFailureCount = 0;

  // Stop the poll loop immediately so no more requests fire while we reconnect
  if (pollInterval) { clearTimeout(pollInterval); pollInterval = null; }

  if (roomHeaderStatus) roomHeaderStatus.textContent = statusMessage;
  console.warn("handleServerDead:", statusMessage);

  // Tear down dead peer connections
  Object.keys(peerConnections).forEach(pid => {
    try { peerConnections[pid].close(); } catch (_) {}
    delete peerConnections[pid];
  });
  Object.keys(iceCandidateBuffers).forEach(pid => { delete iceCandidateBuffers[pid]; });
  Object.keys(lastProcessedOfferSdp).forEach(pid => { delete lastProcessedOfferSdp[pid]; });
  Object.keys(offerProcessingLock).forEach(pid => { delete offerProcessingLock[pid]; });

  // Remove stale remote video cards
  if (videoGrid) videoGrid.querySelectorAll(".video-card.remote").forEach(c => c.remove());

  scheduleReconnect();
}

/**
 * Exponential-backoff reconnect: re-joins the same room then re-offers
 * WebRTC to all existing participants.
 * Backoff: 2s → 3s → 4.5s … capped at 15s.
 */
let reconnectInProgress = false; // prevents two parallel reconnect fetches

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (!roomId || !username) return;

  const delay = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(1.5, reconnectAttempt), MAX_RECONNECT_DELAY_MS);
  reconnectAttempt++;
  console.log(`Reconnect attempt ${reconnectAttempt} in ${Math.round(delay / 1000)}s…`);

  reconnectTimer = setTimeout(async () => {
    if (!roomId || !username) return;
    // Hard guard: if a reconnect fetch is already running, do nothing.
    // handleServerDead may be called multiple times from in-flight polls.
    if (reconnectInProgress) {
      console.log("Reconnect already in progress – skipping duplicate");
      return;
    }
    reconnectInProgress = true;
    if (roomHeaderStatus) roomHeaderStatus.textContent = `Reconnecting… (attempt ${reconnectAttempt})`;

    try {
      const response = await fetch("/api/rooms/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room_id: roomId, username: username }),
        signal: AbortSignal.timeout(8000)
      });

      if (!response.ok) {
        console.warn(`Rejoin failed (${response.status}), retrying…`);
        reconnectInProgress = false;
        scheduleReconnect();
        return;
      }

      const data = await response.json();
      userId = data.user_id;
      lastEventId = typeof data.current_event_id === "number" ? data.current_event_id : lastEventId;
      reconnectEventFloor = lastEventId;
      serverDead = false;
      reconnectAttempt = 0;
      reconnectInProgress = false;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

      if (roomHeaderStatus) roomHeaderStatus.textContent = "Connected";
      console.log("Reconnected. Re-establishing peer connections…");

      // Full teardown before re-offering – prevents duplicate peer connections
      Object.keys(peerConnections).forEach(pid => {
        try { peerConnections[pid].close(); } catch (_) {}
        delete peerConnections[pid];
      });
      Object.keys(iceCandidateBuffers).forEach(pid => { delete iceCandidateBuffers[pid]; });
      Object.keys(lastProcessedOfferSdp).forEach(pid => { delete lastProcessedOfferSdp[pid]; });
      Object.keys(offerProcessingLock).forEach(pid => { delete offerProcessingLock[pid]; });
      Object.keys(pendingOffers).forEach(pid => { delete pendingOffers[pid]; });
      if (videoGrid) videoGrid.querySelectorAll(".video-card.remote").forEach(c => c.remove());

      // Re-offer to all current participants, then restart the poll loop
      if (Array.isArray(data.participants)) {
        data.participants.forEach(p => {
          if (p.id !== userId) initiatePeerConnection(p.id, p.name, true);
        });
      }

      // Restart polling at normal speed now that we're back
      currentPollDelay = POLL_DELAY_MIN;
      schedulePoll();

    } catch (err) {
      console.warn("Rejoin error:", err.message);
      reconnectInProgress = false;
      scheduleReconnect();
    }
  }, delay);
}

function handleReceivedEvent(event) {
  const { type, sender, sender_name, data } = event;

  // Don't process our own broadcasted events unless they are targeted reflections
  if (sender === userId) return;

  switch (type) {
    case "join":
      addSystemMessage(`${sender_name} joined the room.`);
      createParticipantCardPlaceholder(sender, sender_name);
      // Deterministic: Only the user with SMALLER ID creates the offer
      // This prevents both sides from creating offers simultaneously
      if (!peerConnections[sender]) {
        const shouldCreateOffer = userId < sender; // Smaller ID creates offer
        initiatePeerConnection(sender, sender_name, shouldCreateOffer);
      }
      break;

    case "leave":
      addSystemMessage(`${sender_name} left the room.`);
      removeParticipantCard(sender);
      break;

    case "chat":
      addChatMessage(sender_name, data.message, false);
      break;

    case "dialogue":
      showDialogueBubble(sender, sender_name, data.word);
      break;

    case "media_state":
      updateParticipantMediaUI(sender, data.media_type, data.enabled);
      break;

    case "webrtc_signal":
      handleWebRTCSignal(sender, sender_name, data);
      break;
  }
}

// ==========================================================================
// WEBRTC MESH IMPLEMENTATION
// ==========================================================================

// Per-peer ICE candidate buffer: holds candidates that arrive before remote description is set
const iceCandidateBuffers = {}; // targetUserId -> RTCIceCandidate[]
// Tracks the SDP fingerprint of the last offer we processed per peer.
// Identical back-to-back offers from the event queue are silently ignored.
const lastProcessedOfferSdp = {}; // targetUserId -> sdp string
const offerProcessingLock = {};    // targetUserId -> bool (mutex against concurrent offer handling)

// TURN credential cache – fetched once per session from the server and reused
// for all peer connections so we don't hammer the credentials endpoint.
let cachedIceServers = null;
let iceServersFetchPromise = null;

/**
 * Fetch TURN credentials from the server-side endpoint and cache them.
 * Falls back to STUN-only if the endpoint is unavailable so the app
 * always works even without a TURN server configured.
 */
async function getIceServers() {
  if (cachedIceServers) return cachedIceServers;
  // If a fetch is already in-flight, wait for it instead of launching a duplicate.
  if (iceServersFetchPromise) return iceServersFetchPromise;

  iceServersFetchPromise = (async () => {
    try {
      const res = await fetch("/api/turn-credentials", { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
          cachedIceServers = data.iceServers;
          console.log("TURN credentials fetched from server:", cachedIceServers.length, "entries");
          return cachedIceServers;
        }
      }
    } catch (err) {
      console.warn("Could not fetch TURN credentials from server:", err.message);
    }
    // Fallback: multiple STUN servers only. Peers behind symmetric NAT will not
    // connect, but this is better than crashing the whole call setup.
    console.warn("Falling back to STUN-only ICE config – peers behind symmetric NAT may fail");
    cachedIceServers = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" },
      { urls: "stun:stun.stunprotocol.org:3478" }
    ];
    return cachedIceServers;
  })();

  return iceServersFetchPromise;
}

async function initiatePeerConnection(targetUserId, targetUserName, isOfferCreator) {
  // If PC already exists, don't recreate it - just ensure it has tracks
  if (peerConnections[targetUserId]) {
    console.log(`Peer connection already exists with ${targetUserName}`);
    if (localStream) {
      localStream.getTracks().forEach(track => {
        const sender = peerConnections[targetUserId]
          .getSenders()
          .find(s => s.track && s.track.kind === track.kind);
        if (!sender) {
          peerConnections[targetUserId].addTrack(track, localStream);
        }
      });
    }
    return peerConnections[targetUserId];
  }

  // Initialise ICE buffer for this peer
  iceCandidateBuffers[targetUserId] = [];

  // Create placeholder card if it doesn't exist
  createParticipantCardPlaceholder(targetUserId, targetUserName);

  // Fetch TURN credentials dynamically so they are always fresh and valid.
  // getIceServers() caches the result for the session lifetime.
  const iceServers = await getIceServers();

  const pc = new RTCPeerConnection({
    iceServers,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
    iceTransportPolicy: "all"
  });

  peerConnections[targetUserId] = pc;
  // connectionAttemptCounts[targetUserId] is intentionally NOT reset here so the
  // count survives across recursive initiatePeerConnection calls on reconnect.
  if (!connectionAttemptCounts[targetUserId]) connectionAttemptCounts[targetUserId] = 0;

  // Add our local tracks to the connection
  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }

  // ICE candidates callback
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      console.log(`ICE candidate for ${targetUserName}:`, e.candidate.candidate.substring(0, 50));
      sendEvent("webrtc_signal", { candidate: e.candidate }, targetUserId);
    } else {
      console.log(`ICE gathering complete for ${targetUserName}`);
    }
  };

  // Remote track received callback
  // FIX: e.streams[0] can be undefined when the browser delivers a track without
  // an associated stream (common with certain codecs / Chrome versions). Build a
  // fallback MediaStream from the raw track so audio/video is never silently lost.
  pc.ontrack = (e) => {
    console.log(`Received remote track from ${targetUserName}:`, e.track.kind);
    const remoteStream = (e.streams && e.streams[0])
      ? e.streams[0]
      : (() => {
          if (!pc._remoteStream) pc._remoteStream = new MediaStream();
          pc._remoteStream.addTrack(e.track);
          return pc._remoteStream;
        })();
    addRemoteParticipantCard(targetUserId, targetUserName, remoteStream);
  };

  // Connection state monitoring with recovery
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    console.log(`Connection state with ${targetUserName}: ${state}`);

    if (state === "failed") {
      // FIX: use the persistent connectionAttemptCounts map instead of a local
      // variable. The old local `connectionAttempts` was re-created at 0 on every
      // recursive call to initiatePeerConnection, so the max-attempts guard never
      // triggered and failed peers retried indefinitely.
      connectionAttemptCounts[targetUserId]++;
      const attempts = connectionAttemptCounts[targetUserId];
      const maxAttempts = 3;
      console.warn(`Connection failed with ${targetUserName} (attempt ${attempts}/${maxAttempts})`);

      if (attempts < maxAttempts) {
        // Full peer teardown + fresh offer is far more reliable than restartIce
        // when using HTTP polling as the signaling transport.
        console.log(`Rebuilding peer connection with ${targetUserName} (attempt ${attempts})…`);

        // FIX: null out the stale srcObject before teardown so the new connection's
        // ontrack handler always triggers a fresh video.srcObject assignment.
        const card = document.getElementById(`video-card-${targetUserId}`);
        if (card) {
          const video = card.querySelector("video");
          if (video) video.srcObject = null;
        }

        try { pc.close(); } catch (_) {}
        delete peerConnections[targetUserId];
        delete iceCandidateBuffers[targetUserId];
        delete pendingOffers[targetUserId];
        // FIX Bug 4: also clear the SDP dedup fingerprint and offer mutex so that
        // a fresh offer from the remote side on the next attempt is not silently
        // discarded by the stale-SDP dedup check in handleWebRTCSignal.
        delete lastProcessedOfferSdp[targetUserId];
        delete offerProcessingLock[targetUserId];
        // Small delay so both sides settle before re-negotiating
        setTimeout(() => {
          if (peerConnections[targetUserId]) return; // already recreated by remote offer
          initiatePeerConnection(targetUserId, targetUserName, isOfferCreator);
        }, 800 * attempts);
      } else {
        console.error(`Giving up on ${targetUserName} after ${maxAttempts} attempts`);
        connectionAttemptCounts[targetUserId] = 0; // reset so a future manual rejoin works
      }
    } else if (state === "connected") {
      console.log(`✓ Successfully connected with ${targetUserName}`);
      connectionAttemptCounts[targetUserId] = 0; // reset on success
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`ICE state with ${targetUserName}: ${pc.iceConnectionState}`);
  };

  pc.onsignalingstatechange = () => {
    console.log(`Signaling state with ${targetUserName}: ${pc.signalingState}`);
  };

  // Only the designated offer-creator sends the initial offer.
  // We use onnegotiationneeded ONLY (no extra setTimeout) to avoid double-offer races.
  if (isOfferCreator) {
    let offerSent = false; // Only one offer per peer connection lifetime

    pc.onnegotiationneeded = async () => {
      if (offerSent) return;           // already negotiated this connection
      if (pc.signalingState !== "stable") {
        console.warn(`onnegotiationneeded skipped – state is ${pc.signalingState}`);
        return;
      }
      offerSent = true;
      try {
        console.log(`Creating offer for ${targetUserName}`);
        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        if (pc.signalingState !== "stable") {
          console.warn(`State changed to ${pc.signalingState} during offer creation; aborting`);
          offerSent = false; // allow retry
          return;
        }
        await pc.setLocalDescription(offer);
        pendingOffers[targetUserId] = true;
        console.log(`Sending offer to ${targetUserName}`);
        sendEvent("webrtc_signal", { sdp: pc.localDescription }, targetUserId);
      } catch (err) {
        console.error("Error creating WebRTC offer:", err);
        offerSent = false; // allow retry on error
      }
    };
  }

  return pc;
}

/**
 * Drain any ICE candidates that were buffered before the remote description
 * was set for this peer.
 */
async function drainIceCandidateBuffer(targetUserId) {
  const buffer = iceCandidateBuffers[targetUserId];
  if (!buffer || buffer.length === 0) return;

  const pc = peerConnections[targetUserId];
  if (!pc) return;

  console.log(`Draining ${buffer.length} buffered ICE candidate(s) for ${targetUserId}`);
  for (const candidate of buffer) {
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      if (!err.message.includes("duplicate")) {
        console.warn(`Error adding buffered ICE candidate:`, err.message);
      }
    }
  }
  iceCandidateBuffers[targetUserId] = [];
}

async function handleWebRTCSignal(senderId, senderName, signalData) {
  let pc = peerConnections[senderId];

  // ── SDP (offer / answer) ──────────────────────────────────────────────────
  if (signalData.sdp) {
    const sessionDesc = signalData.sdp;

    // ── OFFER ──────────────────────────────────────────────────────────────
    if (sessionDesc.type === "offer") {

      const offerKey = sessionDesc.sdp ? sessionDesc.sdp.slice(0, 120) : "";

      // ① Exact-SDP dedup: server re-delivers the same event every poll cycle.
      if (lastProcessedOfferSdp[senderId] === offerKey) {
        return;
      }

      // ② Concurrency mutex: set synchronously before any await so that a
      //    second invocation from the next 200ms poll tick exits here while
      //    we are mid-await. Without this, two concurrent calls both see
      //    "have-local-offer", both call rollback, and the second one then
      //    hits setLocalDescription in the wrong state.
      if (offerProcessingLock[senderId]) {
        return;
      }
      offerProcessingLock[senderId] = true;

      // Create peer connection if this is the first contact from this peer
      if (!pc) {
        pc = initiatePeerConnection(senderId, senderName, false);
      }

      try {
        // GLARE: we sent an offer at the same time as the remote.
        // Deterministic tie-break: the peer with the lexicographically SMALLER
        // userId yields (rolls back) so only one side ends up as answerer.
        if (pc.signalingState === "have-local-offer") {
          if (userId < senderId) {
            // We yield – roll back our offer and accept theirs
            console.log(`Glare with ${senderName} – we yield, rolling back our offer`);
            await pc.setLocalDescription({ type: "rollback" });
          } else {
            // They should yield – discard their offer, keep ours
            console.log(`Glare with ${senderName} – they yield, keeping our offer`);
            delete offerProcessingLock[senderId];
            return;
          }
        }

        if (pc.signalingState === "have-remote-offer") {
          // Already mid-negotiation with a prior offer from this same peer.
          console.log(`Mid-negotiation with ${senderName} – skipping duplicate offer`);
          delete offerProcessingLock[senderId];
          return;
        }

        if (pc.signalingState !== "stable") {
          console.warn(`Cannot accept offer from ${senderName} in state: ${pc.signalingState}`);
          delete offerProcessingLock[senderId];
          return;
        }

        // Record before awaiting so re-entrant calls hit the dedup check above
        lastProcessedOfferSdp[senderId] = offerKey;

        await pc.setRemoteDescription(new RTCSessionDescription(sessionDesc));
        await drainIceCandidateBuffer(senderId);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log(`Sending answer to ${senderName}`);
        sendEvent("webrtc_signal", { sdp: pc.localDescription }, senderId);

      } catch (err) {
        delete lastProcessedOfferSdp[senderId];
        console.error(`Error handling offer from ${senderName}:`, err.message);
      } finally {
        delete offerProcessingLock[senderId];
      }
    }

    // ── ANSWER ─────────────────────────────────────────────────────────────
    else if (sessionDesc.type === "answer") {
      if (!pc) {
        console.warn(`Answer from ${senderName} but no peer connection – ignoring`);
        return;
      }
      if (pc.signalingState === "have-local-offer") {
        try {
          console.log(`Setting remote answer from ${senderName}`);
          await pc.setRemoteDescription(new RTCSessionDescription(sessionDesc));
          delete pendingOffers[senderId];
          await drainIceCandidateBuffer(senderId);
        } catch (err) {
          console.error(`Error handling answer from ${senderName}:`, err.message);
        }
      } else {
        // stable = already applied; anything else = stale replay – both are safe to drop
        console.log(`Ignoring answer from ${senderName} in state ${pc.signalingState}`);
      }
    }
  }

  // ── ICE CANDIDATE ─────────────────────────────────────────────────────────
  else if (signalData.candidate) {
    if (!pc) return; // no connection yet – discard

    if (!pc.remoteDescription || !pc.remoteDescription.type) {
      // Buffer until setRemoteDescription has been called
      if (!iceCandidateBuffers[senderId]) iceCandidateBuffers[senderId] = [];
      iceCandidateBuffers[senderId].push(new RTCIceCandidate(signalData.candidate));
      return;
    }

    try {
      if (pc.signalingState !== "closed") {
        await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
      }
    } catch (err) {
      if (!err.message.includes("duplicate")) {
        console.warn(`ICE candidate error from ${senderName}:`, err.message);
      }
    }
  }
}

// ==========================================================================
// PARTICIPANT CARD RENDERERS
// ==========================================================================

function createParticipantCardPlaceholder(targetUserId, targetUserName) {
  // Check if card exists
  let card = document.getElementById(`video-card-${targetUserId}`);
  if (!card) {
    card = document.createElement("div");
    card.id = `video-card-${targetUserId}`;
    card.className = "video-card remote camera-off";
    
    // Placeholder initials
    const initials = targetUserName.slice(0, 2).toUpperCase();
    card.setAttribute("data-initials", initials);

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = false; // Allow audio from remote participants

    const info = document.createElement("div");
    info.className = "video-info";

    const nameBadge = document.createElement("span");
    nameBadge.className = "username-badge";
    nameBadge.textContent = targetUserName;

    const indicators = document.createElement("div");
    indicators.className = "stream-indicators";

    const micIndicator = document.createElement("span");
    micIndicator.id = `mic-indicator-${targetUserId}`;
    micIndicator.className = "indicator hidden";
    micIndicator.textContent = "🎙️ Muted";

    indicators.appendChild(micIndicator);
    info.appendChild(nameBadge);
    info.appendChild(indicators);

    const dialogueBubble = document.createElement("div");
    dialogueBubble.id = `dialogue-bubble-${targetUserId}`;
    dialogueBubble.className = "dialogue-bubble hidden";

    card.appendChild(video);
    card.appendChild(info);
    card.appendChild(dialogueBubble);

    videoGrid.appendChild(card);
  }
}

function addRemoteParticipantCard(targetUserId, targetUserName, stream) {
  createParticipantCardPlaceholder(targetUserId, targetUserName);
  
  const card = document.getElementById(`video-card-${targetUserId}`);
  if (!card) {
    console.warn(`Card not found for ${targetUserName} after creating placeholder`);
    return;
  }
  
  const video = card.querySelector("video");
  if (!video) {
    console.warn(`Video element not found in card for ${targetUserName}`);
    return;
  }
  
  if (video.srcObject !== stream) {
    console.log(`Setting video stream for ${targetUserName}`);
    video.srcObject = stream;
    
    // Try to play - ignore errors if element is removed
    try {
      const playPromise = video.play();
      if (playPromise !== undefined) {
        playPromise.catch(err => {
          // Only log if it's not an "interrupted" error (expected)
          if (!err.message.includes("interrupted")) {
            console.warn(`Could not play video for ${targetUserName}:`, err.message);
          }
        });
      }
    } catch (err) {
      console.warn(`Error playing video for ${targetUserName}:`, err.message);
    }
  }
  
  // Remove camera off placeholder status once stream is being set
  if (stream && stream.getTracks().length > 0) {
    card.classList.remove("camera-off");
  }
}

function removeParticipantCard(targetUserId) {
  const card = document.getElementById(`video-card-${targetUserId}`);
  if (card) {
    // Stop video playback before removing
    const video = card.querySelector("video");
    if (video) {
      video.srcObject = null;
      video.pause();
    }
    // Remove after a short delay to ensure clean removal
    setTimeout(() => {
      if (card && card.parentNode) {
        card.remove();
      }
    }, 100);
  }

  if (peerConnections[targetUserId]) {
    try {
      peerConnections[targetUserId].close();
    } catch (err) {
      console.warn(`Error closing peer connection with ${targetUserId}:`, err);
    }
    delete peerConnections[targetUserId];
  }

  // Clean up ICE buffer and SDP dedup
  delete iceCandidateBuffers[targetUserId];
  delete lastProcessedOfferSdp[targetUserId];
  delete offerProcessingLock[targetUserId];

  // Clean up pending offer tracking and connection attempt counter
  delete pendingOffers[targetUserId];
  delete connectionAttemptCounts[targetUserId];

  if (bubbleTimers[targetUserId]) {
    clearTimeout(bubbleTimers[targetUserId]);
    delete bubbleTimers[targetUserId];
  }
}

function updateParticipantMediaUI(targetUserId, mediaType, enabled) {
  const card = document.getElementById(`video-card-${targetUserId}`);
  if (!card) return;

  if (mediaType === "camera") {
    card.classList.toggle("camera-off", !enabled);
  } 
  else if (mediaType === "mic") {
    const micInd = document.getElementById(`mic-indicator-${targetUserId}`);
    if (micInd) {
      micInd.classList.toggle("hidden", enabled);
    }
  }
}

// Toggle local camera track
function toggleLocalCamera() {
  if (!localStream) return;
  cameraOn = !cameraOn;
  localStream.getVideoTracks().forEach(track => track.enabled = cameraOn);
  
  cameraToggleBtn.classList.toggle("muted", !cameraOn);
  cameraToggleBtn.textContent = cameraOn ? "📹" : "❌";

  const localCard = document.getElementById("local-video-card");
  if (localCard) {
    localCard.classList.toggle("camera-off", !cameraOn);
  }

  // Notify peer room
  sendEvent("media_state", { media_type: "camera", enabled: cameraOn });
}

// Toggle local mic track
function toggleLocalMic() {
  if (!localStream) return;
  micOn = !micOn;
  localStream.getAudioTracks().forEach(track => track.enabled = micOn);
  
  micToggleBtn.classList.toggle("muted", !micOn);
  micToggleBtn.textContent = micOn ? "🎙️" : "❌";

  const localMicIndicator = document.getElementById("local-mic-indicator");
  if (localMicIndicator) {
    localMicIndicator.classList.toggle("hidden", micOn);
  }

  // Notify peer room
  sendEvent("media_state", { media_type: "mic", enabled: micOn });
}

// ==========================================================================
// CHAT & TRANSCRIPTION INTERFACE
// ==========================================================================

function setupEventListeners() {
  // Lobby join button
  if (joinMeetingBtn) joinMeetingBtn.addEventListener("click", joinMeeting);
  if (randomRoomBtn) randomRoomBtn.addEventListener("click", generateRandomRoomId);

  // Lobby cam/mic toggle
  if (lobbyCamToggle) lobbyCamToggle.addEventListener("click", toggleLobbyCam);
  if (lobbyMicToggle) lobbyMicToggle.addEventListener("click", toggleLobbyMic);

  // Meeting controls
  if (micToggleBtn) micToggleBtn.addEventListener("click", toggleLocalMic);
  if (cameraToggleBtn) cameraToggleBtn.addEventListener("click", toggleLocalCamera);
  if (recognitionToggleBtn) recognitionToggleBtn.addEventListener("click", () => toggleSignRecognition(!recognitionActive));
  if (leaveBtn) leaveBtn.addEventListener("click", leaveMeeting);

  // Header copy
  if (copyRoomBtn) copyRoomBtn.addEventListener("click", copyRoomLink);
  if (themeToggleBtn) themeToggleBtn.addEventListener("click", toggleTheme);

  // Sidebar toggle & tabs
  if (sidebarToggleBtn) sidebarToggleBtn.addEventListener("click", toggleSidebar);
  if (tabChat) tabChat.addEventListener("click", () => switchSidebarTab("chat"));
  if (tabVocab) tabVocab.addEventListener("click", () => switchSidebarTab("vocab"));

  // Chat message send
  if (sendChatBtn) sendChatBtn.addEventListener("click", sendChatMessageInput);
  if (chatInput) {
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        sendChatMessageInput();
      }
    });
  }
}

function copyRoomLink() {
  navigator.clipboard.writeText(roomId).then(() => {
    const oldText = copyRoomBtn.textContent;
    copyRoomBtn.textContent = "Copied!";
    setTimeout(() => {
      copyRoomBtn.textContent = oldText;
    }, 1500);
  }).catch(err => {
    console.error("Clipboard copy failed:", err);
  });
}

function toggleSidebar() {
  sidebar.classList.toggle("hidden");
  sidebarToggleBtn.classList.toggle("active", !sidebar.classList.contains("hidden"));
}

function switchSidebarTab(tabName) {
  if (tabName === "chat") {
    tabChat.classList.add("active");
    tabVocab.classList.remove("active");
    panelChat.classList.add("active");
    panelVocab.classList.remove("active");
  } else {
    tabChat.classList.remove("active");
    tabVocab.classList.add("active");
    panelChat.classList.remove("active");
    panelVocab.classList.add("active");
  }
}

function addSystemMessage(text) {
  const el = document.createElement("div");
  el.className = "system-message font-outfit";
  el.textContent = text;
  chatBox.appendChild(el);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function addChatMessage(senderName, text, isLocal = false) {
  const el = document.createElement("div");
  el.className = `chat-bubble ${isLocal ? 'local' : 'remote'}`;
  
  const senderSpan = document.createElement("span");
  senderSpan.className = "sender-name";
  senderSpan.textContent = isLocal ? "You" : senderName;
  
  const textNode = document.createTextNode(text);
  
  el.appendChild(senderSpan);
  el.appendChild(textNode);
  chatBox.appendChild(el);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function addSignTranscriptionMessage(senderName, word, isLocal = false) {
  const el = document.createElement("div");
  el.className = "chat-bubble sign-translation";

  const tagSpan = document.createElement("span");
  tagSpan.className = "translation-tag";
  tagSpan.textContent = isLocal ? "You signed" : `${senderName} signed`;

  const wordSpan = document.createElement("span");
  wordSpan.textContent = `"${word}"`;

  el.appendChild(tagSpan);
  el.appendChild(wordSpan);
  chatBox.appendChild(el);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function sendChatMessageInput() {
  const text = chatInput.value.trim();
  if (!text) return;

  // Add locally
  addChatMessage("You", text, true);
  
  // Broadcast to room
  sendEvent("chat", { message: text });

  chatInput.value = "";
}

// ==========================================================================
// SPEECH DIALOGUE BUBBLES DISPLAY
// ==========================================================================

function showDialogueBubble(targetUserId, targetUserName, word) {
  const bubble = document.getElementById(
    targetUserId === userId ? "local-dialogue-bubble" : `dialogue-bubble-${targetUserId}`
  );
  if (!bubble) return;

  bubble.textContent = word;
  bubble.classList.remove("hidden");

  // Add speaking class animation to the card border
  const card = document.getElementById(
    targetUserId === userId ? "local-video-card" : `video-card-${targetUserId}`
  );
  if (card) {
    card.classList.add("speaking");
  }

  // Clear previous timer for this bubble
  if (bubbleTimers[targetUserId]) {
    clearTimeout(bubbleTimers[targetUserId]);
  }

  // Fade out bubble after 3 seconds of inactivity
  bubbleTimers[targetUserId] = setTimeout(() => {
    bubble.classList.add("hidden");
    if (card) {
      card.classList.remove("speaking");
    }
  }, 3000);

  // Append word to sidebar transcript log
  addSignTranscriptionMessage(targetUserName, word, targetUserId === userId);
}

// ==========================================================================
// LOCAL MEDIAPIPE LOBBY/MEETING SKELETON TRACKER
// ==========================================================================

let poseResolveLocal = null;
let handsResolveLocal = null;

const MEDIAPIPE_POSE_VERSION = "0.5.1675469404";
const MEDIAPIPE_HANDS_VERSION = "0.4.1675469240";

function resolveMediapipeAsset(file, fallbackSolution) {
  const solution = file.startsWith("hands_")
    ? "hands"
    : file.startsWith("pose_")
      ? "pose"
      : fallbackSolution;

  const version = solution === "pose" ? MEDIAPIPE_POSE_VERSION : MEDIAPIPE_HANDS_VERSION;
  return `https://cdn.jsdelivr.net/npm/@mediapipe/${solution}@${version}/${file}`;
}

const pose = new Pose({
  locateFile: (file) => resolveMediapipeAsset(file, "pose")
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
  if (poseResolveLocal) {
    poseResolveLocal(results);
    poseResolveLocal = null;
  }
});

const hands = new Hands({
  locateFile: (file) => resolveMediapipeAsset(file, "hands")
});

hands.setOptions({
  staticImageMode: false,
  maxNumHands: 2,
  modelComplexity: 0,
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5
});

hands.onResults((results) => {
  if (handsResolveLocal) {
    handsResolveLocal(results);
    handsResolveLocal = null;
  }
});

function processPose(image) {
  return new Promise((resolve) => {
    poseResolveLocal = resolve;
    pose.send({ image: image }).catch(err => {
      poseResolveLocal = null;
      console.error("Pose send error:", err);
      resolve(null);
    });
  });
}

function processHands(image) {
  return new Promise((resolve) => {
    handsResolveLocal = resolve;
    hands.send({ image: image }).catch(err => {
      handsResolveLocal = null;
      console.error("Hands send error:", err);
      resolve(null);
    });
  });
}

// Flattens MediaPipe landmark points to simple array
function flattenLandmarks(landmarks, count) {
  if (!landmarks) {
    return new Array(count * 3).fill(0);
  }
  const arr = [];
  for (let i = 0; i < count; i++) {
    const pt = landmarks[i];
    if (!pt) {
      arr.push(0, 0, 0);
    } else {
      arr.push(pt.x || 0, pt.y || 0, pt.z || 0);
    }
  }
  return arr;
}

function getHandLabel(handedness) {
  if (!handedness) return "";
  if (handedness.label) return handedness.label;
  if (handedness.classification && handedness.classification[0]) {
    return handedness.classification[0].label;
  }
  return "";
}

function extractKeypoints(poseResults, handsResults) {
  const poseKp = flattenLandmarks(poseResults ? poseResults.poseLandmarks : null, 33);
  let leftHandKp = new Array(21 * 3).fill(0);
  let rightHandKp = new Array(21 * 3).fill(0);

  if (handsResults && handsResults.multiHandLandmarks && handsResults.multiHandLandmarks.length > 0) {
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

// Flip frame left-to-right (mimics cv2.flip(frame, 1))
function prepareProcessingFrame() {
  processCtx.save();
  processCtx.clearRect(0, 0, CAMERA_WIDTH, CAMERA_HEIGHT);
  processCtx.translate(CAMERA_WIDTH, 0);
  processCtx.scale(-1, 1);
  processCtx.drawImage(webcamElement, 0, 0, CAMERA_WIDTH, CAMERA_HEIGHT);
  processCtx.restore();
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

  if (boxWidth <= 0 || boxHeight <= 0) return;

  const size = Math.max(boxWidth, boxHeight);
  const cx = (xMin + xMax) / 2;
  const cy = (yMin + yMax) / 2;
  const half = size / 2 + 15;

  const x1 = Math.max(0, cx - half);
  const y1 = Math.max(0, cy - half);
  const x2 = Math.min(CAMERA_WIDTH, cx + half);
  const y2 = Math.min(CAMERA_HEIGHT, cy + half);

  // Modern cyber-glowing bounding box
  canvasCtx.save();
  canvasCtx.shadowColor = "rgba(16, 185, 129, 0.8)";
  canvasCtx.shadowBlur = 12;
  canvasCtx.strokeStyle = "rgba(16, 185, 129, 0.4)";
  canvasCtx.lineWidth = 2;
  
  // Draw rounded card borders
  canvasCtx.beginPath();
  const radius = 10;
  if (typeof canvasCtx.roundRect === "function") {
    canvasCtx.roundRect(x1, y1, x2 - x1, y2 - y1, radius);
  } else {
    canvasCtx.rect(x1, y1, x2 - x1, y2 - y1);
  }
  canvasCtx.stroke();
  canvasCtx.restore();
}

function drawDisplayFrame(poseResults, handsResults) {
  if (!canvasElement || !canvasCtx) return;
  
  canvasElement.width = CAMERA_WIDTH;
  canvasElement.height = CAMERA_HEIGHT;
  canvasCtx.clearRect(0, 0, CAMERA_WIDTH, CAMERA_HEIGHT);

  // Draw hand connections with simple neon green
  if (handsResults && handsResults.multiHandLandmarks && handsResults.multiHandLandmarks.length > 0) {
    handsResults.multiHandLandmarks.forEach((handLandmarks) => {
      // Connectors
      drawConnectors(canvasCtx, handLandmarks, HAND_CONNECTIONS, {
        color: "#10b981",
        lineWidth: 2
      });

      // Joint points
      drawLandmarks(canvasCtx, handLandmarks, {
        color: "#00ffff",
        fillColor: "#10b981",
        radius: 2,
        lineWidth: 1
      });

      // Bounding box
      drawHandBox(handLandmarks);
    });
  }
}

// ==========================================================================
// PREDICTION WORKFLOW (CLIENT LANDMARKS -> FLASK MODEL)
// ==========================================================================

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
  const confidentEnough = prediction.confidence >= CONFIDENCE_THRESHOLD;
  const marginEnough = prediction.margin >= MINIMUM_PREDICTION_MARGIN;
  return confidentEnough && marginEnough;
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

async function sendPrediction() {
  if (isPredicting) return;

  const now = Date.now();
  if (now - lastPredictionTime < PREDICTION_INTERVAL_MS) return;

  lastPredictionTime = now;
  isPredicting = true;

  try {
    const response = await fetch("/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sequence: sequence })
    });

    if (!response.ok) {
      isPredicting = false;
      return;
    }

    const data = await response.json();
    const smoothed = smoothPrediction(data);
    const sure = isPredictionSure(smoothed);

    if (sure) {
      const stable = confirmStablePrediction(smoothed.word);

      if (stable) {
        // Prevent immediate duplicates
        if (smoothed.word !== lastAddedWord || now - lastAddedTime > WORD_REPEAT_DELAY_MS) {
          lastAddedWord = smoothed.word;
          lastAddedTime = now;
          
          // Display bubble locally
          showDialogueBubble(userId, username, smoothed.word);
          
          // Broadcast to meeting peers
          sendEvent("dialogue", { word: smoothed.word });
        }
        resetPredictionStability();
      }
    } else {
      resetPredictionStability();
    }
  } catch (error) {
    console.error("Prediction API error:", error);
  }

  isPredicting = false;
}

// Core loop processing video frames
async function frameLoop() {
  if (!frameLoopActive || currentScreen !== "meeting") return;

  // Make sure we have a track running
  if (webcamElement && webcamElement.readyState === webcamElement.HAVE_ENOUGH_DATA) {
    prepareProcessingFrame();

    // Extract landmarks
    const poseResults = await processPose(processCanvas);
    const handsResults = await processHands(processCanvas);

    // Render skeleton
    drawDisplayFrame(poseResults, handsResults);

    // Prediction sequence building
    if (recognitionActive && cameraOn) {
      const hasHand = handsResults && handsResults.multiHandLandmarks && handsResults.multiHandLandmarks.length > 0;

      if (!hasHand) {
        sequence = [];
        predictionQueue = [];
        resetPredictionStability();
        updateStatusIndicator("Show hands inside camera");
      } else {
        const keypoints = extractKeypoints(poseResults, handsResults);
        if (keypoints.length === NUM_FEATURES) {
          sequence.push(keypoints);
          if (sequence.length > SEQUENCE_LENGTH) {
            sequence.shift();
          }

          if (sequence.length < SEQUENCE_LENGTH) {
            updateStatusIndicator(`Buffering: ${sequence.length}/${SEQUENCE_LENGTH}`);
          } else {
            updateStatusIndicator("Translating signs...");
            void sendPrediction();
          }
        }
      }
    } else {
      // Clear queues when recognition is off
      sequence = [];
      predictionQueue = [];
      resetPredictionStability();
    }
  }

  // Schedule the next frame ONLY after the current frame finishes processing!
  if (frameLoopActive) {
    requestAnimationFrame(frameLoop);
  }
}

function updateStatusIndicator(status) {
  if (recognitionStatusText) {
    recognitionStatusText.textContent = recognitionActive ? status : "Model Standby";
  }
}

function toggleSignRecognition(forceState = null) {
  recognitionActive = forceState !== null ? forceState : !recognitionActive;
  
  body.classList.toggle("recognition-active", recognitionActive);
  recognitionToggleBtn.classList.toggle("muted", !recognitionActive);
  recognitionToggleBtn.textContent = recognitionActive ? "🤖" : "❌";
  
  updateStatusIndicator(recognitionActive ? "Active" : "Model Standby");

  if (!recognitionActive) {
    sequence = [];
    predictionQueue = [];
    resetPredictionStability();
    if (canvasCtx) {
      canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    }
  }
}