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

// Speech bubble timers
const bubbleTimers = {}; // userId -> setTimeout ID

// Timers for polling and heartbeats
let pollInterval = null;
let heartbeatInterval = null;

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

    // Connect WebRTC to all existing participants in the room
    data.participants.forEach(p => {
      // Joiner initiates peer connection
      initiatePeerConnection(p.id, p.name, true);
    });

    // Start local camera/mic stream
    await startMeetingStream();

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

function startSyncIntervals() {
  // Sync events every 1 second (1000ms)
  pollInterval = setInterval(pollEvents, 1000);
  
  // Heartbeat every 4 seconds
  heartbeatInterval = setInterval(sendHeartbeat, 4000);
}

function stopSyncIntervals() {
  clearInterval(pollInterval);
  clearInterval(heartbeatInterval);
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
    console.error("Heartbeat error:", err);
  }
}

// Broadcast client action/media changes to room
async function sendEvent(eventType, eventData = {}, recipient = null) {
  if (!roomId || !userId) return;
  try {
    await fetch(`/api/rooms/${roomId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        event_type: eventType,
        data: eventData,
        recipient: recipient
      })
    });
  } catch (err) {
    console.error("Post event error:", err);
  }
}

// ==========================================================================
// HTTP POLLING EVENT SYNCER
// ==========================================================================

async function pollEvents() {
  if (!roomId || !userId) return;
  try {
    const response = await fetch(`/api/rooms/${roomId}/events?user_id=${userId}&last_event_id=${lastEventId}`);
    if (!response.ok) return;

    const data = await response.json();
    if (data.events && data.events.length > 0) {
      data.events.forEach(event => {
        handleReceivedEvent(event);
        lastEventId = Math.max(lastEventId, event.id);
      });
    }
  } catch (err) {
    console.error("Polling events error:", err);
  }
}

function handleReceivedEvent(event) {
  const { type, sender, sender_name, data } = event;

  // Don't process our own broadcasted events unless they are targeted reflections
  if (sender === userId) return;

  switch (type) {
    case "join":
      addSystemMessage(`${sender_name} joined the room.`);
      // Add empty video card placeholder
      createParticipantCardPlaceholder(sender, sender_name);
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

function initiatePeerConnection(targetUserId, targetUserName, isOfferCreator) {
  // If PC already exists, close it first
  if (peerConnections[targetUserId]) {
    peerConnections[targetUserId].close();
  }

  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" }
    ]
  });

  peerConnections[targetUserId] = pc;

  // Add our local tracks to the connection
  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }

  // ICE candidates callback
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendEvent("webrtc_signal", { candidate: e.candidate }, targetUserId);
    }
  };

  // Remote track received callback
  pc.ontrack = (e) => {
    const remoteStream = e.streams[0];
    addRemoteParticipantCard(targetUserId, targetUserName, remoteStream);
  };

  // Negotiation handler (Only run if we are the connection initiator)
  if (isOfferCreator) {
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendEvent("webrtc_signal", { sdp: offer }, targetUserId);
      } catch (err) {
        console.error("Error creating WebRTC offer:", err);
      }
    };
  }

  return pc;
}

async function handleWebRTCSignal(senderId, senderName, signalData) {
  let pc = peerConnections[senderId];

  // Receive Session SDP Offer or Answer
  if (signalData.sdp) {
    const sessionDesc = signalData.sdp;

    if (sessionDesc.type === "offer") {
      // Receiver initializes peer connection passively (not the initiator)
      pc = initiatePeerConnection(senderId, senderName, false);
      await pc.setRemoteDescription(new RTCSessionDescription(sessionDesc));

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendEvent("webrtc_signal", { sdp: answer }, senderId);
    } 
    else if (sessionDesc.type === "answer") {
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(sessionDesc));
      }
    }
  } 
  // Receive ICE Candidate
  else if (signalData.candidate) {
    if (pc) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
      } catch (err) {
        console.error("Error adding received ICE candidate:", err);
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
  if (card) {
    const video = card.querySelector("video");
    if (video && video.srcObject !== stream) {
      video.srcObject = stream;
      video.play();
    }
    // Remove camera off placeholder status once stream is rendering
    card.classList.remove("camera-off");
  }
}

function removeParticipantCard(targetUserId) {
  const card = document.getElementById(`video-card-${targetUserId}`);
  if (card) {
    card.remove();
  }

  if (peerConnections[targetUserId]) {
    peerConnections[targetUserId].close();
    delete peerConnections[targetUserId];
  }

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
      console.error("Pose send error:", err);
      resolve(null);
    });
  });
}

function processHands(image) {
  return new Promise((resolve) => {
    handsResolveLocal = resolve;
    hands.send({ image: image }).catch(err => {
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
    const [poseResults, handsResults] = await Promise.all([
      processPose(processCanvas),
      processHands(processCanvas)
    ]);

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
