"""
Session 04 — Feature Engineering pipeline (IDS SS 2026).

Turns four raw streams per recording session into a session x 14 feature table:

    accelerometer.csv  -> step_count, cadence, gait_regularity, activity_ratio
    accelerometer.csv  -> mean_rotation, rotation_variability     (gyro cols gx/gy/gz)
    audio.wav          -> mean_loudness, vocal_activity_ratio,
                          loudness_variability, loudness_trend
    video.mp4          -> mean_mouth_opening, mouth_opening_rate,
                          opening_variability, opening_trend

IMPORTANT — the phone/webcam was mounted rotated by -90 deg, so every video frame
is stored on its side. Faces are undetectable in the raw frames. The video stage
rotates each frame back upright (90 deg counter-clockwise) BEFORE running MediaPipe
FaceMesh. This was verified empirically: only the CCW orientation yields a face.

Run:
    python feature_pipeline.py --data-dir /path/to/data --out-dir ./outputs
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import cv2
import librosa
import numpy as np
import pandas as pd
from scipy.signal import find_peaks

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Camera rotation correction. The recording was shot with the camera turned -90 deg,
# so we rotate each frame +90 deg (counter-clockwise) to bring the face upright.
ROTATE_FLAG = cv2.ROTATE_90_COUNTERCLOCKWISE

# MediaPipe FaceMesh landmark indices
LM_UPPER_LIP = 13
LM_LOWER_LIP = 14
LM_MOUTH_CORNER_RIGHT = 61   # inner mouth corners, for horizontal opening
LM_MOUTH_CORNER_LEFT = 291
LM_IRIS_RIGHT = 468   # requires refine_landmarks=True
LM_IRIS_LEFT = 473
LM_EYE_OUTER_RIGHT = 33   # fallback if iris landmarks unavailable
LM_EYE_OUTER_LEFT = 263

# Physical calibration: assume an adult interpupillary distance of ~63 mm.
ASSUMED_IPD_MM = 63.0

# Accelerometer / gyroscope
ACTIVITY_THRESHOLD_G = 1.05      # |a| above resting gravity => moving
STEP_HEIGHT_G = 1.2              # heel-strike impact threshold on |a|
STEP_MIN_INTERVAL_S = 0.30       # >= 0.3 s between steps (<= 200 steps/min)

# Voice
AUDIO_SR = 16000                 # resample so 512/256 frames ~= 32 ms / 16 ms
RMS_FRAME = 512
RMS_HOP = 256
VOICE_ACTIVITY_THRESHOLD = 0.01  # RMS above this => voiced frame


# ---------------------------------------------------------------------------
# Part 1 + 3 — Accelerometer & gyroscope features (single IMU CSV)
# ---------------------------------------------------------------------------

def accel_gyro_features(csv_path: str | Path) -> dict:
    df = pd.read_csv(csv_path)

    t = df["t_s"].values
    duration_s = float(t[-1] - t[0])
    fs = 1.0 / np.median(np.diff(t))     # ~100 Hz for this dataset

    # Total movement magnitude (direction-independent). Robust to the fact that
    # gravity here rests on the -Z axis instead of +Z as in the course example.
    magnitude = np.sqrt(df["ax_g"] ** 2 + df["ay_g"] ** 2 + df["az_g"] ** 2).values

    # --- Step detection on the movement magnitude ---
    min_dist = max(1, int(STEP_MIN_INTERVAL_S * fs))
    peaks, _ = find_peaks(magnitude, height=STEP_HEIGHT_G, distance=min_dist)

    step_count = int(len(peaks))
    cadence = step_count / duration_s * 60 if duration_s > 0 else 0.0

    if len(peaks) >= 2:
        intervals_s = np.diff(peaks) / fs
        gait_regularity = float(np.std(intervals_s))
    else:
        gait_regularity = float("nan")

    activity_ratio = float((magnitude > ACTIVITY_THRESHOLD_G).mean())

    # --- Gyroscope: rotational movement (deg/s) ---
    gyro_mag = np.sqrt(df["gx_dps"] ** 2 + df["gy_dps"] ** 2 + df["gz_dps"] ** 2).values
    mean_rotation = float(np.mean(gyro_mag))
    rotation_variability = float(np.std(gyro_mag))

    return {
        "step_count": step_count,
        "cadence": cadence,
        "gait_regularity": gait_regularity,
        "activity_ratio": activity_ratio,
        "mean_rotation": mean_rotation,
        "rotation_variability": rotation_variability,
    }


# ---------------------------------------------------------------------------
# Part 2 — Voice features (WAV -> RMS)
# ---------------------------------------------------------------------------

def voice_features(wav_path: str | Path) -> dict:
    audio, sr = librosa.load(wav_path, sr=AUDIO_SR, mono=True)

    rms = librosa.feature.rms(
        y=audio, frame_length=RMS_FRAME, hop_length=RMS_HOP
    )[0]

    mean_loudness = float(rms.mean())
    vocal_activity_ratio = float((rms > VOICE_ACTIVITY_THRESHOLD).mean())
    loudness_variability = float(rms.std())

    # Loudness trend over the session (RMS per second). Negative => quieting.
    time_axis = np.arange(len(rms)) * RMS_HOP / sr
    loudness_trend = float(np.polyfit(time_axis, rms, 1)[0]) if len(rms) > 1 else 0.0

    return {
        "mean_loudness": mean_loudness,
        "vocal_activity_ratio": vocal_activity_ratio,
        "loudness_variability": loudness_variability,
        "loudness_trend": loudness_trend,
    }


# ---------------------------------------------------------------------------
# Part 4 — Video features (rotation-corrected MediaPipe FaceMesh)
# ---------------------------------------------------------------------------

# Model for the modern MediaPipe Tasks API (used when the legacy Solutions
# API was removed from the installed mediapipe version). Downloaded once.
FACE_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/latest/face_landmarker.task"
)
FACE_MODEL_PATH = Path(__file__).parent / "models" / "face_landmarker.task"


def _ensure_face_model() -> Path:
    if not FACE_MODEL_PATH.exists():
        import sys
        import urllib.request

        FACE_MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = FACE_MODEL_PATH.with_suffix(".task.part")
        print(f"Downloading face landmark model to {FACE_MODEL_PATH} ...",
              file=sys.stderr, flush=True)
        try:
            urllib.request.urlretrieve(FACE_MODEL_URL, tmp)
            tmp.rename(FACE_MODEL_PATH)  # atomic: no corrupt half-downloads
        except Exception as exc:
            tmp.unlink(missing_ok=True)
            raise RuntimeError(
                f"Could not download the face landmark model ({exc}). "
                f"Download it manually from {FACE_MODEL_URL} and save it as "
                f"{FACE_MODEL_PATH}"
            ) from exc
    return FACE_MODEL_PATH


def _make_face_landmarker():
    """Return (detect, close) working on any installed mediapipe version.

    detect(rgb_frame, timestamp_ms) -> indexable landmarks (with .x/.y) or None.
    Prefers the legacy Solutions FaceMesh; newer mediapipe releases removed it,
    in which case the Tasks-API FaceLandmarker is used (same 478 landmarks,
    including iris 468/473, so all landmark indices stay valid).
    """
    import mediapipe as mp

    if hasattr(mp, "solutions"):
        fm = mp.solutions.face_mesh.FaceMesh(
            static_image_mode=False,
            max_num_faces=1,
            refine_landmarks=True,          # enables iris landmarks (468/473)
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        )

        def detect(rgb, _ts_ms):
            res = fm.process(rgb)
            if not res.multi_face_landmarks:
                return None
            return res.multi_face_landmarks[0].landmark

        return detect, fm.close

    from mediapipe.tasks import python as mp_tasks
    from mediapipe.tasks.python import vision

    landmarker = vision.FaceLandmarker.create_from_options(
        vision.FaceLandmarkerOptions(
            base_options=mp_tasks.BaseOptions(
                model_asset_path=str(_ensure_face_model())
            ),
            running_mode=vision.RunningMode.VIDEO,
            num_faces=1,
        )
    )

    def detect(rgb, ts_ms):
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        res = landmarker.detect_for_video(image, ts_ms)
        if not res.face_landmarks:
            return None
        return res.face_landmarks[0]

    return detect, landmarker.close

def extract_mouth_opening(
    video_path: str | Path,
    rotate_flag: int = ROTATE_FLAG,
    save_csv: str | Path | None = None,
    save_preview: str | Path | None = None,
):
    """Return a DataFrame [timestamp, mouth_opening_mm] extracted from video.

    Each frame is rotated upright before FaceMesh so the -90 deg mounted camera
    does not break face detection.
    """
    cap = cv2.VideoCapture(str(video_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0

    rows = []
    preview_saved = save_preview is None
    frame_idx = 0

    detect, close = _make_face_landmarker()
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break

            if rotate_flag is not None:
                frame = cv2.rotate(frame, rotate_flag)
            h, w = frame.shape[:2]

            timestamp = frame_idx / fps
            rgb = np.ascontiguousarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            lm = detect(rgb, int(timestamp * 1000))

            if lm is not None:

                def px(i):
                    return np.array([lm[i].x * w, lm[i].y * h])

                mouth_px = np.linalg.norm(px(LM_UPPER_LIP) - px(LM_LOWER_LIP))
                mouth_h_px = np.linalg.norm(
                    px(LM_MOUTH_CORNER_RIGHT) - px(LM_MOUTH_CORNER_LEFT)
                )

                # Calibrate pixels -> mm via interpupillary distance.
                try:
                    ipd_px = np.linalg.norm(px(LM_IRIS_RIGHT) - px(LM_IRIS_LEFT))
                except IndexError:
                    ipd_px = np.linalg.norm(
                        px(LM_EYE_OUTER_RIGHT) - px(LM_EYE_OUTER_LEFT)
                    )
                if ipd_px > 1e-6:
                    mm_per_px = ASSUMED_IPD_MM / ipd_px
                    mouth_mm = float(mouth_px * mm_per_px)
                    mouth_h_mm = float(mouth_h_px * mm_per_px)
                    rows.append((timestamp, mouth_mm, mouth_h_mm))

                    if not preview_saved:
                        _save_overlay(frame, px, save_preview)
                        preview_saved = True

            frame_idx += 1
    finally:
        close()

    cap.release()

    df = pd.DataFrame(
        rows, columns=["timestamp", "mouth_opening_mm", "mouth_opening_h_mm"]
    )
    detection_rate = len(df) / frame_idx if frame_idx else 0.0

    if save_csv is not None and not df.empty:
        out = df.copy()
        out["timestamp"] = out["timestamp"]  # seconds from start
        out.to_csv(save_csv, index=False)

    return df, detection_rate


def _save_overlay(frame, px, path):
    img = frame.copy()
    for i, color in [
        (LM_UPPER_LIP, (0, 255, 0)),
        (LM_LOWER_LIP, (0, 255, 0)),
    ]:
        p = px(i).astype(int)
        cv2.circle(img, tuple(p), 3, color, -1)
    p1 = px(LM_UPPER_LIP).astype(int)
    p2 = px(LM_LOWER_LIP).astype(int)
    cv2.line(img, tuple(p1), tuple(p2), (0, 255, 255), 1)
    cv2.imwrite(str(path), img)


def video_features(
    video_path: str | Path,
    fps_hint: float = 25.0,
    save_csv: str | Path | None = None,
    save_preview: str | Path | None = None,
) -> dict:
    df_mouth, detection_rate = extract_mouth_opening(
        video_path, save_csv=save_csv, save_preview=save_preview
    )

    if df_mouth.empty:
        return {
            "mean_mouth_opening": float("nan"),
            "mouth_opening_rate": float("nan"),
            "opening_variability": float("nan"),
            "opening_trend": float("nan"),
            "video_detection_rate": detection_rate,
        }

    # Light 3-frame rolling median removes single-frame landmark jitter
    # (occasional bad FaceMesh fits) without distorting the real dynamics.
    df_mouth = df_mouth.copy()
    df_mouth["mouth_opening_mm"] = (
        df_mouth["mouth_opening_mm"].rolling(3, center=True, min_periods=1).median()
    )

    signal = df_mouth["mouth_opening_mm"].values
    ts = df_mouth["timestamp"].values
    fps = 1.0 / np.median(np.diff(ts)) if len(ts) > 1 else fps_hint
    duration_s = float(ts[-1] - ts[0]) if len(ts) > 1 else 0.0

    mean_mouth_opening = float(signal.mean())

    peaks, _ = find_peaks(
        signal,
        height=signal.mean() * 0.6,          # relative threshold (angle-robust)
        distance=max(1, int(0.2 * fps)),     # >= 0.2 s between syllable bursts
    )
    mouth_opening_rate = len(peaks) / duration_s * 60 if duration_s > 0 else 0.0

    opening_variability = float(signal.std())
    opening_trend = (
        float(np.polyfit(ts, signal, 1)[0]) if len(signal) > 1 else 0.0
    )

    return {
        "mean_mouth_opening": mean_mouth_opening,
        "mouth_opening_rate": mouth_opening_rate,
        "opening_variability": opening_variability,
        "opening_trend": opening_trend,
        "video_detection_rate": detection_rate,
    }


# ---------------------------------------------------------------------------
# Combine — one function, all four streams
# ---------------------------------------------------------------------------

def extract_features(session_dir: str | Path, out_dir: str | Path | None = None,
                     label: str = "") -> dict:
    session_dir = Path(session_dir)
    mouth_csv = mouth_preview = None
    if out_dir is not None:
        out_dir = Path(out_dir)
        (out_dir / "mouth").mkdir(parents=True, exist_ok=True)
        (out_dir / "preview").mkdir(parents=True, exist_ok=True)
        mouth_csv = out_dir / "mouth" / f"{label or session_dir.name}_mouth.csv"
        mouth_preview = out_dir / "preview" / f"{label or session_dir.name}_overlay.png"

    feats = {}
    feats.update(accel_gyro_features(session_dir / "accelerometer.csv"))
    feats.update(voice_features(session_dir / "audio.wav"))
    feats.update(
        video_features(
            session_dir / "video.mp4",
            save_csv=mouth_csv,
            save_preview=mouth_preview,
        )
    )
    return feats


# ---------------------------------------------------------------------------
# Visualisation — 2x2 summary panel
# ---------------------------------------------------------------------------

def plot_summary(df_features: pd.DataFrame, out_path: str | Path):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    sessions = list(df_features.index)
    n = len(sessions)
    # red -> green gradient across sessions (worse -> better direction)
    cmap = plt.cm.RdYlGn
    colors = [cmap(i / max(1, n - 1)) for i in range(n)]

    panels = {
        "Accelerometer": ["step_count", "cadence", "gait_regularity", "activity_ratio"],
        "Voice": ["mean_loudness", "vocal_activity_ratio",
                  "loudness_variability", "loudness_trend"],
        "Gyroscope": ["mean_rotation", "rotation_variability"],
        "Video": ["mean_mouth_opening", "mouth_opening_rate",
                  "opening_variability", "opening_trend"],
    }

    fig, axes = plt.subplots(2, 2, figsize=(16, 11))
    for ax, (title, feats) in zip(axes.flat, panels.items()):
        feats = [f for f in feats if f in df_features.columns]
        m = len(feats)
        width = 0.8 / max(1, n)
        x = np.arange(m)
        for si, s in enumerate(sessions):
            vals = df_features.loc[s, feats].values.astype(float)
            ax.bar(x + si * width, vals, width=width, color=colors[si],
                   edgecolor="none", label=s)
        ax.set_xticks(x + width * (n - 1) / 2)
        ax.set_xticklabels(feats, rotation=20, ha="right", fontsize=10)
        ax.set_title(title, fontsize=15)
        ax.axhline(0, color="#888", lw=0.6)
        ax.legend(fontsize=8, ncol=2)

    fig.suptitle("Feature summary — all sessions", fontsize=19)
    fig.tight_layout(rect=[0, 0, 1, 0.97])
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    plt.close(fig)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data-dir", required=True,
                    help="Folder containing one sub-folder per session")
    ap.add_argument("--out-dir", default="./outputs")
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    all_dirs = [p for p in data_dir.iterdir() if p.is_dir()]
    skipped = [p for p in all_dirs if not (p / "video.mp4").exists()]
    for p in skipped:
        print(f"WARNING: skipping {p.name} — no video.mp4 (incomplete upload?)",
              flush=True)

    # Chronological order (upload time), NOT alphabetical UUID order.
    # Rows are keyed by the exercise id (= folder name = server's exerciseId),
    # so features can be joined back to experiments in the database.
    session_dirs = sorted(
        (p for p in all_dirs if (p / "video.mp4").exists()),
        key=lambda p: p.stat().st_mtime,
    )

    rows = {}
    for i, sd in enumerate(session_dirs):
        exercise_id = sd.name
        print(f"[session_{i + 1}] {exercise_id} ...", flush=True)
        feats = extract_features(sd, out_dir=out_dir, label=exercise_id)
        feats["session"] = i + 1  # chronological ordinal, kept for readability
        rows[exercise_id] = feats
        print(f"    detection_rate={feats.get('video_detection_rate', 0):.2%} "
              f"steps={feats['step_count']} cadence={feats['cadence']:.1f}",
              flush=True)

    df = pd.DataFrame(rows).T
    df.index.name = "exercise_id"

    # keep the 14 clinical features in a stable order for the table
    feature_order = [
        "session",
        "step_count", "cadence", "gait_regularity", "activity_ratio",
        "mean_loudness", "vocal_activity_ratio", "loudness_variability",
        "loudness_trend", "mean_rotation", "rotation_variability",
        "mean_mouth_opening", "mouth_opening_rate", "opening_variability",
        "opening_trend",
    ]
    table = df[feature_order]
    table.to_csv(out_dir / "feature_table.csv")
    df.to_csv(out_dir / "feature_table_full.csv")  # incl. detection_rate

    # Short readable labels for the plot; the CSVs keep full exercise ids.
    plot_table = table.drop(columns=["session"]).copy()
    plot_table.index = [
        f"s{int(table.loc[e, 'session'])}:{str(e)[:8]}" for e in table.index
    ]
    plot_summary(plot_table, out_dir / "feature_summary.png")

    print("\n=== feature_table (features x sessions) ===")
    print(table.T.round(3).to_string())
    print(f"\nSaved: {out_dir/'feature_table.csv'}")
    print(f"Saved: {out_dir/'feature_summary.png'}")


if __name__ == "__main__":
    main()
