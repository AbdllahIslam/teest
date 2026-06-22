# Use eventlet for async Socket.IO support in hosted environments (Railway, Heroku, etc.)
import eventlet
eventlet.monkey_patch()

from pathlib import Path
from collections import defaultdict
import pickle

import numpy as np
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room, leave_room, rooms as socket_rooms
import tensorflow as tf
from tensorflow.keras.models import load_model, Sequential
from tensorflow.keras.layers import LSTM, Dense, Dropout, BatchNormalization
import os

BASE_DIR = Path(__file__).resolve().parent

MODEL_PATH = BASE_DIR / "best_model.h5"
CLASSES_PATH = BASE_DIR / "classes.pkl"

# Allow supplying a remote model URL (e.g., S3) when deploying to platforms with repo size limits.
MODEL_URL = os.environ.get("MODEL_URL")
CLASSES_URL = os.environ.get("CLASSES_URL")
if not MODEL_PATH.exists() and MODEL_URL:
    try:
        print(f"[INFO] Downloading model from {MODEL_URL} to {MODEL_PATH} ...")
        import urllib.request
        urllib.request.urlretrieve(MODEL_URL, str(MODEL_PATH))
        print("[OK] Model downloaded.")
    except Exception as e:
        print("[WARN] Failed to download model:", e)

if not CLASSES_PATH.exists() and CLASSES_URL:
    try:
        print(f"[INFO] Downloading classes from {CLASSES_URL} to {CLASSES_PATH} ...")
        import urllib.request
        urllib.request.urlretrieve(CLASSES_URL, str(CLASSES_PATH))
        print("[OK] Classes downloaded.")
    except Exception as e:
        print("[WARN] Failed to download classes:", e)

FRAMES = 15
NUM_FEATURES = 225

app = Flask(__name__, static_folder=".", static_url_path="")
CORS(app)
# Prefer eventlet if available so WebSocket transport works in production.
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")
room_members = defaultdict(set)


def load_classes():
    if not CLASSES_PATH.exists():
        raise FileNotFoundError(
            f"classes.pkl not found at: {CLASSES_PATH}\n"
            "Copy classes.pkl into the same folder as server.py."
        )

    with open(CLASSES_PATH, "rb") as f:
        classes = pickle.load(f)

    return list(classes)


ACTIONS = load_classes()


def build_model_from_weights():
    model = Sequential([
        LSTM(128, return_sequences=True, input_shape=(FRAMES, NUM_FEATURES)),
        BatchNormalization(),
        Dropout(0.3),

        LSTM(64, return_sequences=False),
        BatchNormalization(),
        Dropout(0.3),

        Dense(64, activation="relu"),
        Dropout(0.3),

        Dense(len(ACTIONS), activation="softmax")
    ])

    model.build((None, FRAMES, NUM_FEATURES))
    model.load_weights(MODEL_PATH, by_name=True, skip_mismatch=True)

    return model


def load_sign_model():
    if not MODEL_PATH.exists():
        raise FileNotFoundError(f"Model not found at: {MODEL_PATH}")

    try:
        loaded_model = load_model(MODEL_PATH, compile=False)
        print("[OK] Loaded full Keras model.")
        return loaded_model
    except Exception as error:
        print("[INFO] load_model failed. Trying architecture + weights.")
        print("[INFO] Reason:", error)

        loaded_model = build_model_from_weights()
        print("[OK] Loaded model using architecture + weights.")
        return loaded_model


model = None
SEQUENCE_LENGTH = FRAMES
MODEL_FEATURES = NUM_FEATURES

# Load model but don't crash the process if loading fails at startup. Expose health endpoint.
try:
    with tf.device("/CPU:0"):
        model = load_sign_model()
    # If loaded, override sequence/features to actual model shape
    if model is not None and getattr(model, 'input_shape', None):
        SEQUENCE_LENGTH = model.input_shape[1]
        MODEL_FEATURES = model.input_shape[2]
except Exception as e:
    print("[ERROR] Model failed to load at startup:", e)
    model = None


@app.route("/")
def home():
    return send_from_directory(".", "index.html")


@app.route("/styles.css")
def styles():
    return send_from_directory(".", "styles.css")


@app.route("/app.js")
def app_js():
    return send_from_directory(".", "app.js")


@app.route("/health")
def health():
    model_loaded = model is not None
    input_shape = list(model.input_shape) if model_loaded and getattr(model, 'input_shape', None) else None
    output_shape = list(model.output_shape) if model_loaded and getattr(model, 'output_shape', None) else None

    return jsonify({
        "ok": True,
        "model_loaded": model_loaded,
        "input_shape": input_shape,
        "output_shape": output_shape,
        "classes": len(ACTIONS)
    })


@socketio.on('join')
def handle_join(data):
    room = data.get('room')
    if room:
        join_room(room)
        room_members[room].add(request.sid)

        existing_peers = [
            sid for sid in room_members[room]
            if sid != request.sid
        ]

        emit('room-peers', {
            'room': room,
            'sid': request.sid,
            'peers': existing_peers
        })

        emit('peer-joined', {
            'sid': request.sid,
            'room': room
        }, room=room, include_self=False)


@socketio.on('signal')
def handle_signal(data):
    # data: { 'target': target_sid, 'signal': <offer/answer/ice> }
    target = data.get('target')
    signal = data.get('signal')
    if target and signal is not None:
        emit('signal', {'source': request.sid, 'signal': signal}, to=target)


@socketio.on('leave')
def handle_leave(data):
    room = data.get('room')
    if room:
        leave_room(room)
        room_members[room].discard(request.sid)
        if not room_members[room]:
            room_members.pop(room, None)
        emit('peer-left', {'sid': request.sid}, room=room)


@socketio.on('word-update')
def handle_word_update(data):
    room = data.get('room')
    word = data.get('word', '')
    if room:
        emit('word-update', {
            'sid': request.sid,
            'word': word,
            'room': room
        }, room=room, include_self=True)


@socketio.on('disconnect')
def handle_disconnect():
    joined_rooms = [room for room in socket_rooms() if room != request.sid]

    for room in joined_rooms:
        room_members[room].discard(request.sid)
        if not room_members[room]:
            room_members.pop(room, None)
        emit('peer-left', {'sid': request.sid}, room=room)


@app.route("/predict", methods=["POST"])
def predict():
    data = request.get_json()

    if not data or "sequence" not in data:
        return jsonify({"error": "Missing sequence"}), 400

    sequence = np.array(data["sequence"], dtype=np.float32)

    expected_shape = (SEQUENCE_LENGTH, MODEL_FEATURES)

    if sequence.shape != expected_shape:
        return jsonify({
            "error": "Wrong input shape",
            "received": list(sequence.shape),
            "expected": list(expected_shape)
        }), 400

    if model is None:
        return jsonify({"error": "Model not loaded"}), 503

    input_data = np.expand_dims(sequence, axis=0)

    with tf.device("/CPU:0"):
        prediction = model.predict(input_data, verbose=0)[0]

    top_indices = np.argsort(prediction)[-3:][::-1]

    top1_index = int(top_indices[0])
    top2_index = int(top_indices[1])
    top3_index = int(top_indices[2])

    top1_conf = float(prediction[top1_index])
    top2_conf = float(prediction[top2_index])
    top3_conf = float(prediction[top3_index])

    margin = top1_conf - top2_conf

    return jsonify({
        "word": ACTIONS[top1_index],
        "confidence": top1_conf,
        "index": top1_index,

        "top2_word": ACTIONS[top2_index],
        "top2_confidence": top2_conf,
        "top2_index": top2_index,

        "top3_word": ACTIONS[top3_index],
        "top3_confidence": top3_conf,
        "top3_index": top3_index,

        "margin": float(margin)
    })


if __name__ == "__main__":
    print("===================================")
    print("Model path:", MODEL_PATH)
    print("Classes path:", CLASSES_PATH)
    print("Classes:", ACTIONS)
    print("Input shape:", model.input_shape)
    print("Output shape:", model.output_shape)
    print("===================================")
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host="0.0.0.0", port=port, debug=False, use_reloader=False)
