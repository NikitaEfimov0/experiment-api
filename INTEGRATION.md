# Raspberry Pi Recording Agent — Integration Contract

> Hand-off note for the Experiment API server developer. Describes what the Pi
> agent does today, the HTTP contract it exposes, the one thing it needs the
> server to provide, and where there's room to compromise.

## 1. Overview

The Pi runs a small **HTTP service** (`agent.py`, Python stdlib, listens on
**`0.0.0.0:8090`** by default). It does **only capture + hand-off** — no
processing, no database. The flow is:

- The **server calls the Pi** to start and stop a recording (the Pi exposes
  those endpoints).
- Recording is **open-ended**: it runs from `start` until `stop` (not a fixed
  duration).
- On `stop`, the Pi **pushes the raw files to the server** via one
  `multipart/form-data` POST, then returns a summary.
- The **server does all processing** (mouth opening, sound pressure, gait) and
  stores results; the Pi never computes anything.

**Lifecycle:**

```
server: POST /exercises/{id}/recording/start   (your API)
   └─> Pi:   POST /recording/start {exerciseId}     ← Pi starts camera+mic+accelerometer
                                                       returns 200 once truly recording
... subject performs the exercise ...
server: POST /exercises/{id}/recording/stop    (your API)
   └─> Pi:   POST /recording/stop                    ← Pi stops + finalises files
             Pi ──multipart POST──> server ingestion route   (raw video/audio/csv)
   <── Pi returns manifest + upload result
server: runs processing, stores ExerciseData; GET /exercises/{id}/data serves it
```

## 2. Endpoints the Pi EXPOSES (your server calls these) — implemented & working

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| `GET`  | `/health` | — | `200 {"ok":true,"mock":false,"state":"idle"}` | — |
| `GET`  | `/status` | — | `200` status object (below) | — |
| `POST` | `/recording/start` | `{"exerciseId":"<id>"}` | `200` status object with `state:"recording"` | `400` missing exerciseId · `409` already recording · `500` camera warm-up failed |
| `POST` | `/recording/stop` | — | `200` stop summary (below) | `409` not recording |

**Status object** (`/status` and the `start` response):

```json
{
  "state": "idle|recording|error",
  "exerciseId": "<id>|null",
  "startedAt": "2026-07-06T12:35:15.205Z",
  "endedAt": null,
  "elapsedSeconds": 12.3,
  "mock": false
}
```

**Stop summary** (`/recording/stop` response):

```json
{
  "exerciseId": "<id>",
  "startedAt": "...Z",
  "endedAt": "...Z",
  "files": {
    "video":         {"name": "video.mp4",  "bytes": 123},
    "audio":         {"name": "audio.wav",  "bytes": 456},
    "accelerometer": {"name": "mpu6050.csv","bytes": 789}
  },
  "sensors": {
    "video":         {"ok": true},
    "audio":         {"ok": true},
    "accelerometer": {"ok": true}
  },
  "upload": {"ok": true, "status": 201, "url": "...", "bytes": 12345},
  "mock": false
}
```

**Important behavioural notes:**

- `POST /recording/start` **is not instant** — the Pi camera needs ~1–4 s of
  warm-up, and the call returns only once recording has genuinely begun. Treat
  the returned `startedAt` as authoritative. (Worst-case timeout budget ~18 s.)
- **Only one recording at a time.** A second `start` returns `409`.
- Timestamps are ISO-8601 UTC (`…Z`).

Quick test against the Pi:

```bash
curl -X POST http://<PI_HOST>:8090/recording/start \
     -H 'Content-Type: application/json' -d '{"exerciseId":"demo1"}'
curl http://<PI_HOST>:8090/status
curl -X POST http://<PI_HOST>:8090/recording/stop
```

## 3. What the Pi SENDS the server on stop — **this part needs agreement**

After stopping, the Pi makes **one** request:

- **Method / URL:** `POST {SERVER_BASE_URL}{UPLOAD_PATH_TEMPLATE}`
  - default template: **`/exercises/{exerciseId}/data/raw`**
    → e.g. `POST http://<server>/exercises/demo1/data/raw`
- **Content-Type:** `multipart/form-data`
- **Auth:** `Authorization: Bearer <token>` — only if a token is configured (optional).
- **Parts:**

| Part name | Type | Content |
|---|---|---|
| `exerciseId` | text field | the exercise id |
| `startedAt` | text field | ISO-8601 UTC |
| `endedAt` | text field | ISO-8601 UTC |
| `metadata` | text field | JSON: `{"results":{…per-sensor…},"mock":false}` |
| `video` | file | `video.mp4` (`video/mp4`) |
| `audio` | file | `audio.wav` (`audio/wav`) |
| `accelerometer` | file | `mpu6050.csv` (`text/csv`) |

- **Success = any 2xx.** The Pi doesn't require a specific response body (it just
  logs it). On non-2xx or a network error, the Pi **keeps the files locally** so
  they can be retried — nothing is lost.

> ⚠️ **Open question / blocker:** the published `openapi.yaml` has **no
> raw-ingestion route** — only `start`/`stop` and `GET /data`. So the Pi
> currently assumes `POST /exercises/{id}/data/raw`. We need you to either
> **(a)** implement a raw-upload route and tell me its exact path + expected
> field names, or **(b)** tell me the route/shape you want and I'll match it. On
> the Pi side the path, the bearer token, and the field names are all easy to
> change.

## 4. Raw file formats (so the server knows what it's parsing)

| File | Format | Details |
|---|---|---|
| `video.mp4` | H.264 in MP4, **no audio track** | 640×480, ~15–30 fps (variable, measured after warm-up), stream-copied (not re-encoded) |
| `audio.wav` | WAV PCM | **48000 Hz, 2 channels, 16-bit** (INMP441 via `arecord`) |
| `mpu6050.csv` | CSV, **100 Hz** | header `t_s,ax_g,ay_g,az_g,gx_dps,gy_dps,gz_dps,temp_c` — accel in g, gyro in °/s, temp in °C |

## 5. Which processed signal comes from which raw file (server side)

Per the `ExerciseData` schema in `openapi.yaml`:

| API signal | Derived from | Processing status |
|---|---|---|
| `mouthOpening` (`[vertical, horizontal]` per frame) | `video.mp4` | **Exists** — a working MediaPipe face-landmark pipeline (currently runs on a Mac) that can be handed over / ported to the server. |
| `soundPressure` (Pa/dB) | `audio.wav` | **Not built yet** by anyone. |
| `footSpeed` + `stepLengths` + aggregates | `mpu6050.csv` (foot/gait sensor) | **Not built yet** by anyone. |

Worth deciding who owns each processor.

## 6. What's configurable on the Pi (levers for compromise)

Set via environment variables, so the Pi can match whatever the server decides:

| Var | Default | Purpose |
|---|---|---|
| `AGENT_PORT` | `8090` | where the Pi listens |
| `SERVER_BASE_URL` | `http://localhost:3000` | the server (**must be set to the real address**) |
| `SERVER_TOKEN` | *(empty)* | bearer token, if the server needs auth |
| `UPLOAD_PATH_TEMPLATE` | `/exercises/{exerciseId}/data/raw` | the raw-ingestion route |

## 7. Two possible data-transfer models (in case that's the miscommunication)

- **Model A — Pi PUSHES (implemented now):** Pi uploads raw files to a server
  ingestion route after stop. Server must expose an upload endpoint; Pi must
  know the server URL (+ token).
- **Model B — Server PULLS:** Pi just records and serves the files (e.g. the
  `stop` response lists them and the server fetches them from the Pi). Then the
  Pi needs no server credentials, but the server must be able to reach the Pi.
  The agent can be switched to this — a moderate change, not a rewrite.

## 8. Status summary

- ✅ **Implemented & tested (mock):** `/health`, `/status`, `/recording/start`,
  `/recording/stop`, the capture pipeline (video + audio + accelerometer), and
  the multipart upload client.
- ✅ **Hardware verified:** camera, mic, accelerometer all detected on the Pi;
  agent runs in real mode.
- ⏳ **Not yet run end-to-end on real hardware** (camera was only just reconnected).
- ❌ **Server side, needed from you:** the raw-ingestion route (§3), plus the DB,
  the experiment/exercise CRUD, and the signal processing (§5).
