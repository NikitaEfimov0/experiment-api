"""Per-exercise extraction for the Experiment API server.

Called by the server (src/pipeline-runner.js) after the Pi uploads raw files:

    python extract_exercise.py /path/to/data/<exerciseId>

Prints ONE JSON object to stdout:

    {
      "features":  { ...the 14 clinical features + video_detection_rate... },
      "mouthOpening": { "values": [[vertical_mm, horizontal_mm], ...],
                         "sampleRate": <Hz> },
      "soundPressure": { "values": [dBFS, ...], "sampleRate": <Hz>,
                          "unit": "dB" }
    }

Everything else (aggregates, storage) is computed by the server. Diagnostics
go to stderr; stdout carries only the JSON.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import librosa
import numpy as np

from feature_pipeline import (
    AUDIO_SR,
    RMS_FRAME,
    RMS_HOP,
    accel_gyro_features,
    extract_mouth_opening,
    video_features,
    voice_features,
)


def sound_pressure_series(wav_path: Path) -> dict:
    """RMS loudness in dBFS (0 = full scale, more negative = quieter)."""
    audio, sr = librosa.load(wav_path, sr=AUDIO_SR, mono=True)
    rms = librosa.feature.rms(y=audio, frame_length=RMS_FRAME, hop_length=RMS_HOP)[0]
    dbfs = 20.0 * np.log10(np.maximum(rms, 1e-10))
    return {
        "values": [round(float(v), 2) for v in dbfs],
        "sampleRate": round(sr / RMS_HOP, 2),
        "unit": "dB",
    }


def clean(value: float) -> float | None:
    """JSON has no NaN/Infinity; replace with null."""
    return None if (isinstance(value, float) and not math.isfinite(value)) else value


def main() -> int:
    exercise_dir = Path(sys.argv[1])

    features: dict = {}
    features.update(accel_gyro_features(exercise_dir / "accelerometer.csv"))
    features.update(voice_features(exercise_dir / "audio.wav"))
    features.update(video_features(exercise_dir / "video.mp4"))

    df_mouth, _detection_rate = extract_mouth_opening(exercise_dir / "video.mp4")
    if len(df_mouth) > 1:
        ts = df_mouth["timestamp"].values
        mouth_rate = 1.0 / float(np.median(np.diff(ts)))
    else:
        mouth_rate = 30.0
    mouth_values = [
        [round(float(v), 3), round(float(h), 3)]
        for v, h in zip(df_mouth["mouth_opening_mm"], df_mouth["mouth_opening_h_mm"])
    ]

    result = {
        "features": {k: clean(float(v)) for k, v in features.items()},
        "mouthOpening": {"values": mouth_values, "sampleRate": round(mouth_rate, 2)},
        "soundPressure": sound_pressure_series(exercise_dir / "audio.wav"),
    }
    json.dump(result, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
