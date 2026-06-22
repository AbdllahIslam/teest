(function () {
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

  let socket;

  try {
    // Try connecting using websocket first, then polling as fallback. Specify the path to align with server.
    socket = typeof io === "function"
      ? io(BACKEND_ORIGIN, { transports: ["websocket", "polling"], path: "/socket.io" })
      : null;
  } catch (error) {
    console.error("Socket.IO client not available or failed to initialize:", error);
    socket = null;
  }

  if (!socket) {
    // Minimal no-op fallback so UI doesn't crash when Socket.IO is unreachable.
    socket = {
      id: "local-fallback",
      on: () => {},
      emit: () => {}
    };
  }

  const roomInput = document.getElementById("roomInput");
  const joinRoomBtn = document.getElementById("joinRoomBtn");
  const leaveRoomBtn = document.getElementById("leaveRoomBtn");
  const remoteGrid = document.getElementById("remoteVideos");
  const connectionPill = document.getElementById("connectionPill");
  const participantsPill = document.getElementById("participantsPill");
  const localStatus = document.getElementById("localStatus");
  const localDetectedWord = document.getElementById("localDetectedWord");

  const peers = {};
  const remoteTiles = {};
  const roomParticipants = new Set();
  let joinedRoom = "";
  let activeSpeakerSid = "";

  const defaultRoom = (window.location.hash || "").replace(/^#/, "").trim();
  if (roomInput && defaultRoom) {
    roomInput.value = defaultRoom;
  }

  function setConnection(text) {
    if (connectionPill) {
      connectionPill.textContent = text;
    }
    if (typeof window.updateConnectionPill === "function") {
      window.updateConnectionPill(text);
    }
  }

  function setConnectionState(isConnected) {
    if (!connectionPill) {
      return;
    }

    connectionPill.textContent = isConnected ? "Connected" : "Disconnected";
    connectionPill.classList.toggle("connection-online", isConnected);
    connectionPill.classList.toggle("connection-offline", !isConnected);
  }

  function updateParticipantCount() {
    if (!participantsPill) {
      return;
    }

    const count = joinedRoom ? roomParticipants.size : 0;
    participantsPill.textContent = `Participants: ${count}`;
  }

  setConnectionState(false);
  updateParticipantCount();

  function setActiveSpeaker(sid) {
    activeSpeakerSid = sid || "";

    const localTile = document.querySelector(".local-tile");
    if (localTile) {
      localTile.classList.toggle("pinned", activeSpeakerSid === socket.id);
    }

    Object.entries(remoteTiles).forEach(([remoteSid, tile]) => {
      tile.classList.toggle("pinned", remoteSid === activeSpeakerSid);
    });
  }

  function setLocalStatus(text) {
    if (localStatus) {
      localStatus.textContent = text;
    }
  }

  function setLocalDetectedWord(word) {
    if (localDetectedWord) {
      localDetectedWord.textContent = word || "Waiting for a sign";
    }
  }

  function normalizeWord(word) {
    return (word || "").trim();
  }

  async function ensureLocalMedia() {
    if (typeof window.startCamera !== "function") {
      throw new Error("Camera controls are unavailable.");
    }

    await window.startCamera();

    if (typeof window.getLocalStream !== "function") {
      throw new Error("Local stream accessor is unavailable.");
    }

    const stream = window.getLocalStream();
    if (!stream) {
      throw new Error("Local camera stream is not ready.");
    }

    return stream;
  }

  function ensureRemoteTile(sid) {
    if (!remoteGrid) {
      return null;
    }

    let tile = remoteTiles[sid];
    if (tile) {
      return tile;
    }

    tile = document.createElement("article");
    tile.className = "remote-tile";
    tile.dataset.remoteSid = sid;

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;

    const meta = document.createElement("div");
    meta.className = "participant-meta";

    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "participant-name";
    name.textContent = `Guest ${sid.slice(-4)}`;
    const state = document.createElement("div");
    state.className = "participant-state";
    state.textContent = "Waiting to connect";
    info.appendChild(name);
    info.appendChild(state);

    const word = document.createElement("div");
    word.className = "participant-word";
    word.textContent = "Waiting for a sign";

    meta.appendChild(info);
    meta.appendChild(word);

    tile.appendChild(video);
    tile.appendChild(meta);
    remoteGrid.appendChild(tile);

    remoteTiles[sid] = tile;
    tile.classList.toggle("pinned", sid === activeSpeakerSid);
    return tile;
  }

  function removeRemoteTile(sid) {
    const tile = remoteTiles[sid];
    if (tile && tile.parentNode) {
      tile.parentNode.removeChild(tile);
    }
    delete remoteTiles[sid];

    if (activeSpeakerSid === sid) {
      setActiveSpeaker("");
    }
  }

  function updateRemoteTileState(sid, text) {
    const tile = remoteTiles[sid];
    if (!tile) {
      return;
    }

    const state = tile.querySelector(".participant-state");
    if (state) {
      state.textContent = text;
    }
  }

  function updateRemoteTileWord(sid, word) {
    const tile = remoteTiles[sid];
    if (!tile) {
      return;
    }

    const wordEl = tile.querySelector(".participant-word");
    if (wordEl) {
      wordEl.textContent = normalizeWord(word) || "Waiting for a sign";
    }
  }

  function attachRemoteStream(sid, stream) {
    const tile = ensureRemoteTile(sid);
    if (!tile) {
      return;
    }

    const video = tile.querySelector("video");
    if (video && video.srcObject !== stream) {
      video.srcObject = stream;
      video.play().catch(() => {});
    }

    updateRemoteTileState(sid, "Connected");
  }

  function createPeerConnection(sid) {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });

    const stream = typeof window.getLocalStream === "function" ? window.getLocalStream() : null;
    if (stream) {
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("signal", {
          target: sid,
          signal: { type: "ice", candidate: event.candidate }
        });
      }
    };

    pc.ontrack = (event) => {
      attachRemoteStream(sid, event.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        updateRemoteTileState(sid, "Connected");
      } else if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
        updateRemoteTileState(sid, pc.connectionState);
      } else if (pc.connectionState === "connecting") {
        updateRemoteTileState(sid, "Connecting");
      }
    };

    return pc;
  }

  async function connectToPeer(sid, initiateOffer) {
    if (!sid || sid === socket.id) {
      return;
    }

    let pc = peers[sid];
    if (!pc) {
      pc = createPeerConnection(sid);
      peers[sid] = pc;
    }

    ensureRemoteTile(sid);

    if (initiateOffer) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("signal", {
          target: sid,
          signal: { type: "offer", sdp: pc.localDescription }
        });
      } catch (error) {
        console.error("Failed to create offer for peer:", error);
      }
    }
  }

  async function joinRoom(room) {
    const nextRoom = normalizeWord(room);
    if (!nextRoom) {
      return;
    }

    await ensureLocalMedia();

    if (joinedRoom && joinedRoom !== nextRoom) {
      await leaveRoom(joinedRoom);
    }

    joinedRoom = nextRoom;

    if (roomInput) {
      roomInput.value = nextRoom;
    }

    if (window.location.hash !== `#${nextRoom}`) {
      window.location.hash = nextRoom;
    }

    setConnectionState(true);
    setConnection(`Connected`);
    socket.emit("join", { room: nextRoom });
    setLocalStatus("In room");
    updateParticipantCount();
  }

  async function leaveRoom(room) {
    const targetRoom = normalizeWord(room || joinedRoom);

    if (targetRoom) {
      socket.emit("leave", { room: targetRoom });
    }

    Object.keys(peers).forEach((sid) => {
      try {
        peers[sid].close();
      } catch (error) {
        // ignore close failures
      }
      delete peers[sid];
    });

    Object.keys(remoteTiles).forEach(removeRemoteTile);

    roomParticipants.clear();
    joinedRoom = "";
    setActiveSpeaker("");
    setConnectionState(false);
    setConnection("Disconnected");
    updateParticipantCount();
    setLocalStatus("Ready");
  }

  function broadcastDetectedWord(word) {
    const cleanWord = normalizeWord(word);
    setLocalDetectedWord(cleanWord);
    setActiveSpeaker(socket.id);

    if (cleanWord && joinedRoom) {
      socket.emit("word-update", {
        room: joinedRoom,
        word: cleanWord
      });
    }
  }

  socket.on("connect", () => {
    setConnectionState(true);
    setConnection(joinedRoom ? "Connected" : "Connected");
  });

  socket.on("room-peers", async (data) => {
    const peersList = Array.isArray(data.peers) ? data.peers : [];
    const room = data.room || joinedRoom;

    if (room && !joinedRoom) {
      joinedRoom = room;
    }

    if (data.sid) {
      roomParticipants.add(data.sid);
    }
    peersList.forEach((sid) => roomParticipants.add(sid));

    setConnectionState(true);
    setConnection(`Connected`);
    setLocalStatus("In room");
    updateParticipantCount();

    for (const sid of peersList) {
      await connectToPeer(sid, true);
    }
  });

  socket.on("peer-joined", (data) => {
    const sid = data.sid;
    if (sid === socket.id) {
      return;
    }

    roomParticipants.add(sid);
    ensureRemoteTile(sid);
    updateRemoteTileState(sid, "Joined");
    updateParticipantCount();
  });

  socket.on("signal", async (data) => {
    const source = data.source;
    const signal = data.signal;

    if (!source || source === socket.id) {
      return;
    }

    let pc = peers[source];
    if (!pc) {
      pc = createPeerConnection(source);
      peers[source] = pc;
    }

    ensureRemoteTile(source);

    try {
      if (signal.type === "offer") {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("signal", {
          target: source,
          signal: { type: "answer", sdp: pc.localDescription }
        });
      } else if (signal.type === "answer") {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      } else if (signal.type === "ice" && signal.candidate) {
        await pc.addIceCandidate(signal.candidate);
      }
    } catch (error) {
      console.warn("WebRTC signal handling failed:", error);
    }
  });

  socket.on("peer-left", (data) => {
    const sid = data.sid;

    if (peers[sid]) {
      try {
        peers[sid].close();
      } catch (error) {
        // ignore close failures
      }
      delete peers[sid];
    }

    removeRemoteTile(sid);
    roomParticipants.delete(sid);
    updateParticipantCount();
  });

  socket.on("word-update", (data) => {
    const sid = data.sid;
    const word = normalizeWord(data.word);

    if (sid === socket.id) {
      setLocalDetectedWord(word);
      setActiveSpeaker(socket.id);
      return;
    }

    ensureRemoteTile(sid);
    updateRemoteTileWord(sid, word);
  });

  socket.on("disconnect", () => {
    Object.keys(peers).forEach((sid) => {
      try {
        peers[sid].close();
      } catch (error) {
        // ignore close failures
      }
      delete peers[sid];
    });

    Object.keys(remoteTiles).forEach(removeRemoteTile);
    roomParticipants.clear();
    joinedRoom = "";
    setActiveSpeaker("");
    setConnectionState(false);
    setConnection("Disconnected");
    updateParticipantCount();
    setLocalStatus("Ready");
  });

  if (joinRoomBtn) {
    joinRoomBtn.addEventListener("click", async () => {
      const room = roomInput ? roomInput.value : "";
      try {
        await joinRoom(room);
      } catch (error) {
        console.error("Failed to join room:", error);
        setConnection("Could not join the room");
      }
    });
  }

  if (leaveRoomBtn) {
    leaveRoomBtn.addEventListener("click", async () => {
      try {
        await leaveRoom();
      } catch (error) {
        console.error("Failed to leave room:", error);
      }
    });
  }

  if (roomInput) {
    roomInput.addEventListener("keydown", async (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        try {
          await joinRoom(roomInput.value);
        } catch (error) {
          console.error("Failed to join room:", error);
          setConnection("Could not join the room");
        }
      }
    });
  }

  if (defaultRoom && joinRoomBtn) {
    window.setTimeout(() => {
      joinRoom(defaultRoom).catch((error) => {
        console.error("Auto-join failed:", error);
      });
    }, 0);
  }

  window.joinRoom = joinRoom;
  window.leaveRoom = leaveRoom;
  window.broadcastDetectedWord = broadcastDetectedWord;
  window.setLocalDetectedWord = setLocalDetectedWord;
  window.setLocalStatus = setLocalStatus;
})();
