# Feature Engineering Pipeline — Session 04 (IDS SS 2026)

Turns four raw streams per session into a `sessions × 14` feature table.

## The camera rotation problem

Every `video.mp4` was recorded with the camera mounted **−90°** (turned on its
side), so faces lie horizontally in the stored frames. In that orientation
MediaPipe FaceMesh detects **no face at all**. The pipeline therefore rotates
each frame **90° counter-clockwise** (`cv2.ROTATE_90_COUNTERCLOCKWISE`) *before*
running FaceMesh — this was verified empirically: of `raw / CW / CCW`, only CCW
yields a detected face. After correction, face-detection rate is **100 %** on all
five sessions.

## Streams → 14 features

| Stream | Source file | Features |
|---|---|---|
| Accelerometer | `accelerometer.csv` | step_count, cadence, gait_regularity, activity_ratio |
| Gyroscope | `accelerometer.csv` (`gx/gy/gz_dps`) | mean_rotation, rotation_variability |
| Voice | `audio.wav` | mean_loudness, vocal_activity_ratio, loudness_variability, loudness_trend |
| Video | `video.mp4` | mean_mouth_opening, mouth_opening_rate, opening_variability, opening_trend |

Note: this dataset stores accelerometer **and** gyroscope in one IMU CSV (there is
no separate `gyro_*.csv` as in the course mock). Gravity here rests on the **−Z**
axis (~−1.0 g), so step detection runs on the movement **magnitude**
`√(x²+y²+z²)`, not a single axis.

Video mouth opening uses landmarks **13 (upper) / 14 (lower)** inner lips, calibrated
from pixels to mm via interpupillary distance (assumed 63 mm, iris landmarks
468/473). A 3-frame rolling median removes single-frame landmark jitter.

## Run

```bash
pip install mediapipe librosa soundfile scipy pandas matplotlib
python feature_pipeline.py --data-dir ../data --out-dir ./outputs
```

## Outputs (`outputs/`)

- `feature_table.csv` — sessions × 14 features (the table for analysis)
- `feature_table_full.csv` — same, plus per-session `video_detection_rate`
- `feature_summary.png` — 2×2 bar-chart summary (one panel per stream)
- `mouth/<session>_mouth.csv` — per-frame `timestamp, mouth_opening_mm`
- `preview/<session>_overlay.png` — first-detected frame with mouth landmarks

## Caveats

- **Session order** is assigned by folder name (`session_1..5`); the recordings
  carry no timestamp, so re-label if you know the true chronological order.
- **session_5** is a short at-rest recording (no walking, minimal speech):
  `step_count=0`, `mean_rotation≈4 dps`, `vocal_activity_ratio≈0.16`. Its
  `mouth_opening_rate` is noise-driven (relative peak threshold on a near-flat
  signal) and should not be read as fast speech.
- The recordings are extreme close-up selfies; FaceMesh fit degrades on
  occasional frames. Aggregate features (mean/std/trend) are robust, but treat
  absolute mm values as approximate.
