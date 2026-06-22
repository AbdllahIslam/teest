from pathlib import Path
import pickle

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


@app.route("/")
def home():
    return send_from_directory(".", "index.html")


@app.route("/styles.css")
def styles():
    return send_from_directory(".", "styles.css")


@app.route("/app.js")
def app_js():
    return send_from_directory(".", "app.js")


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
    print("===================================")
    print("Model path:", MODEL_PATH)
    print("Classes path:", CLASSES_PATH)
    print("Classes:", ACTIONS)
    print("Input shape:", model.input_shape)
    print("Output shape:", model.output_shape)
    print("===================================")

    app.run(host="127.0.0.1", port=5000, debug=True, use_reloader=False)