from pathlib import Path
from tensorflow.keras.models import load_model

BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = BASE_DIR / "my_alphabet_model.h5"

print("Looking for model at:", MODEL_PATH)
print("Model exists:", MODEL_PATH.exists())

model = load_model(MODEL_PATH, compile=False)

print("Input shape:", model.input_shape)
print("Output shape:", model.output_shape)