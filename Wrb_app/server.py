from pathlib import Path
import pickle
import time
import uuid

import numpy as np
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import tensorflow as tf
from tensorflow.keras.models import load_model, Sequential
from tensorflow.keras.layers import LSTM, Dense, Dropout, BatchNormalization


BASE_DIR = Path(__file__).resolve().parent

MODEL_PATH = BASE_DIR / "best_model.h5"
CLASSES_PATH = BASE_DIR / "classes.pkl"

FRAMES = 15
NUM_FEATURES = 225

app = Flask(__name__, static_folder=".", static_url_path="")
CORS(app)


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


with tf.device("/CPU:0"):
    model = load_sign_model()


SEQUENCE_LENGTH = model.input_shape[1]
MODEL_FEATURES = model.input_shape[2]



# Room and Signaling Database in memory
ROOMS = {}

def cleanup_room(room_id):
    if room_id not in ROOMS:
        return
    now = time.time()
    room = ROOMS[room_id]
    to_remove = []
    
    for user_id, p in room["participants"].items():
        # If no heartbeat for 8 seconds, consider disconnected
        if now - p["last_seen"] > 8.0:
            to_remove.append(user_id)
            
    for user_id in to_remove:
        username = room["participants"][user_id]["name"]
        print(f"[CLEANUP] User {username} ({user_id}) timed out from room {room_id}")
        del room["participants"][user_id]
        
        # Add leave event
        event_id = len(room["events"]) + 1
        room["events"].append({
            "id": event_id,
            "type": "leave",
            "sender": user_id,
            "sender_name": username,
            "timestamp": now
        })
        
    # If room is empty, remove it entirely
    if not room["participants"]:
        print(f"[CLEANUP] Room {room_id} is empty. Deleting room.")
        del ROOMS[room_id]


@app.route("/")
def home():
    return send_from_directory(".", "index.html")


@app.route("/styles.css")
def styles():
    return send_from_directory(".", "styles.css")


@app.route("/app.js")
def app_js():
    return send_from_directory(".", "app.js")


@app.route("/api/rooms/join", methods=["POST"])
def join_room():
    data = request.get_json() or {}
    room_id = str(data.get("room_id", "")).strip()
    username = str(data.get("username", "")).strip()
    
    if not room_id or not username:
        return jsonify({"error": "Missing room_id or username"}), 400
        
    user_id = str(uuid.uuid4())
    
    if room_id not in ROOMS:
        ROOMS[room_id] = {
            "participants": {},
            "events": []
        }
    
    cleanup_room(room_id)
    
    # Check if room still exists after cleanup, otherwise recreate
    if room_id not in ROOMS:
        ROOMS[room_id] = {
            "participants": {},
            "events": []
        }
        
    ROOMS[room_id]["participants"][user_id] = {
        "id": user_id,
        "name": username,
        "last_seen": time.time()
    }
    
    event_id = len(ROOMS[room_id]["events"]) + 1
    ROOMS[room_id]["events"].append({
        "id": event_id,
        "type": "join",
        "sender": user_id,
        "sender_name": username,
        "timestamp": time.time()
    })
    
    # Return details and existing participants list
    other_participants = [
        {"id": pid, "name": p["name"]}
        for pid, p in ROOMS[room_id]["participants"].items()
        if pid != user_id
    ]
    
    return jsonify({
        "user_id": user_id,
        "participants": other_participants
    })


@app.route("/api/rooms/<room_id>/leave", methods=["POST"])
def leave_room(room_id):
    data = request.get_json() or {}
    user_id = data.get("user_id")
    
    if room_id in ROOMS and user_id in ROOMS[room_id]["participants"]:
        username = ROOMS[room_id]["participants"][user_id]["name"]
        del ROOMS[room_id]["participants"][user_id]
        
        event_id = len(ROOMS[room_id]["events"]) + 1
        ROOMS[room_id]["events"].append({
            "id": event_id,
            "type": "leave",
            "sender": user_id,
            "sender_name": username,
            "timestamp": time.time()
        })
        
        if not ROOMS[room_id]["participants"]:
            del ROOMS[room_id]
            
    return jsonify({"status": "ok"})


@app.route("/api/rooms/<room_id>/heartbeat", methods=["POST"])
def heartbeat(room_id):
    data = request.get_json() or {}
    user_id = data.get("user_id")
    
    if room_id in ROOMS and user_id in ROOMS[room_id]["participants"]:
        ROOMS[room_id]["participants"][user_id]["last_seen"] = time.time()
        
    cleanup_room(room_id)
    return jsonify({"status": "ok"})


@app.route("/api/rooms/<room_id>/events", methods=["POST"])
def post_event(room_id):
    data = request.get_json() or {}
    user_id = data.get("user_id")
    event_type = data.get("event_type")
    event_data = data.get("data", {})
    recipient = data.get("recipient")
    
    if room_id not in ROOMS or user_id not in ROOMS[room_id]["participants"]:
        return jsonify({"error": "User or room not found"}), 404
        
    username = ROOMS[room_id]["participants"][user_id]["name"]
    ROOMS[room_id]["participants"][user_id]["last_seen"] = time.time()
    
    event_id = len(ROOMS[room_id]["events"]) + 1
    ROOMS[room_id]["events"].append({
        "id": event_id,
        "type": event_type,
        "sender": user_id,
        "sender_name": username,
        "recipient": recipient,
        "data": event_data,
        "timestamp": time.time()
    })
    
    cleanup_room(room_id)
    return jsonify({"status": "ok"})


@app.route("/api/rooms/<room_id>/events", methods=["GET"])
def get_events(room_id):
    user_id = request.args.get("user_id")
    last_event_id = int(request.args.get("last_event_id", 0))
    
    if room_id not in ROOMS or user_id not in ROOMS[room_id]["participants"]:
        return jsonify({"error": "User or room not found"}), 404
        
    ROOMS[room_id]["participants"][user_id]["last_seen"] = time.time()
    cleanup_room(room_id)
    
    events = []
    if room_id in ROOMS:
        for ev in ROOMS[room_id]["events"]:
            if ev["id"] > last_event_id:
                # Include event if recipient is not specified or matches the user_id
                if ev.get("recipient") is None or ev.get("recipient") == user_id:
                    events.append(ev)
                    
    return jsonify({"events": events})


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
    import os
    print("===================================")
    print("Model path:", MODEL_PATH)
    print("Classes path:", CLASSES_PATH)
    print("Classes:", ACTIONS)
    print("Input shape:", model.input_shape)
    print("Output shape:", model.output_shape)
    print("===================================")

    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)