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
import pandas as pd
from scipy.integrate import cumulative_trapezoid
from scipy.signal import butter, filtfilt, find_peaks

from feature_pipeline import (
    AUDIO_SR,
    RMS_FRAME,
    RMS_HOP,
    STEP_HEIGHT_G,
    STEP_MIN_INTERVAL_S,
    accel_gyro_features,
    extract_mouth_opening,
    video_features,
    voice_features,
)

# Gait signal extraction (accelerometer.csv -> foot speed + step lengths).
G_MS2 = 9.80665            # 1 g in m/s^2
HP_CUTOFF_HZ = 0.3         # high-pass: removes gravity/DC and integration drift
# Weinberg step-length model  L = K * (a_max - a_min)^(1/4)  per step.
# K is an UNCALIBRATED constant tuned so magnitudes land in a plausible 30-80 cm
# range; calibrate it against a known walked distance for quantitative use.
STEP_WEINBERG_K = 0.35


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


def _highpass(x: np.ndarray, fs: float, cutoff: float = HP_CUTOFF_HZ, order: int = 2) -> np.ndarray:
    """Zero-phase high-pass. Falls back to mean-removal for very short signals
    (filtfilt needs length > 3*(order+1))."""
    nyq = fs / 2.0
    wn = min(0.99, cutoff / nyq)
    b, a = butter(order, wn, btype="high")
    if len(x) <= 3 * max(len(a), len(b)):
        return x - np.mean(x)
    return filtfilt(b, a, x)


def gait_series(csv_path: Path) -> dict | None:
    """Foot speed (cm/s time series) and per-step length (cm) from the IMU.

    Foot speed: gravity is removed from each axis with a high-pass filter, the
    resulting linear acceleration is integrated to velocity, and the velocity is
    high-passed again to cancel integration drift; speed = |velocity|. This is a
    single-IMU estimate (no zero-velocity updates), so treat it as a movement-
    speed proxy rather than a calibrated ground-truth foot speed.

    Step lengths: heel-strike peaks on the acceleration magnitude (same detector
    as the step_count feature), then the Weinberg model L = K*(a_max-a_min)^(1/4)
    per step. See STEP_WEINBERG_K on calibration.
    """
    df = pd.read_csv(csv_path)
    t = df["t_s"].values.astype(float)
    if len(t) < 3:
        return None
    dt = np.diff(t)
    fs = 1.0 / float(np.median(dt))

    axes = np.vstack([df["ax_g"].values, df["ay_g"].values, df["az_g"].values]).astype(float) * G_MS2

    # Linear acceleration (gravity/DC removed), then integrate -> velocity ->
    # de-drifted velocity -> speed magnitude.
    lin = np.vstack([_highpass(axes[i], fs) for i in range(3)])
    vel = np.vstack([_highpass(cumulative_trapezoid(lin[i], t, initial=0.0), fs) for i in range(3)])
    speed_cms = np.sqrt((vel ** 2).sum(axis=0)) * 100.0

    foot_speed = {
        "values": [round(float(v), 2) for v in speed_cms],
        "sampleRate": round(fs, 2),
        "unit": "cm/s",
    }

    # Per-step lengths via Weinberg on the acceleration magnitude (in g).
    mag_g = np.sqrt((df[["ax_g", "ay_g", "az_g"]].values.astype(float) ** 2).sum(axis=1))
    peaks, _ = find_peaks(mag_g, height=STEP_HEIGHT_G, distance=max(1, int(STEP_MIN_INTERVAL_S * fs)))
    step_lengths = []
    for i in range(1, len(peaks)):
        seg = mag_g[peaks[i - 1]: peaks[i] + 1] * G_MS2  # m/s^2
        rng = float(seg.max() - seg.min())
        if rng > 0:
            step_lengths.append(round(STEP_WEINBERG_K * (rng ** 0.25) * 100.0, 1))  # cm

    return {"footSpeed": foot_speed, "stepLengths": {"values": step_lengths, "unit": "cm"}}


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
        "gait": gait_series(exercise_dir / "accelerometer.csv"),
    }
    json.dump(result, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
