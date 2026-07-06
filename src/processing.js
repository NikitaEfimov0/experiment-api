'use strict';

// ---------------------------------------------------------------------------
// Signal processing: raw Pi files -> ExerciseData (see INTEGRATION.md §5).
//
// Ownership status:
//   mouthOpening  <- video.mp4    : MediaPipe pipeline exists (runs on a Mac),
//                                   to be ported here. PLACEHOLDER below.
//   soundPressure <- audio.wav    : not built yet by anyone. PLACEHOLDER below.
//   footSpeed etc <- mpu6050.csv  : not built yet by anyone. PLACEHOLDER below.
//
// The placeholders produce spec-shaped data (correct structure, units, sample
// rates, real timestamps and durations derived from the actual recording) so
// the API and UI work end-to-end. Replace each `process*` function with the
// real implementation without touching anything else.
// ---------------------------------------------------------------------------

const fs = require('fs');

const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const rand = (min, max) => min + Math.random() * (max - min);
const round = (v, d) => +v.toFixed(d);

/** PLACEHOLDER — replace with the ported MediaPipe face-landmark pipeline. */
function processVideo(_videoPath, durationS) {
  const sampleRate = 30;
  const n = Math.max(1, Math.round(durationS * sampleRate));
  const values = Array.from({ length: n }, () => [round(rand(0, 0.3), 4), round(rand(0, 0.5), 4)]);
  return { values, sampleRate };
}

/** PLACEHOLDER — replace with real sound-pressure extraction from the WAV. */
function processAudio(_audioPath, durationS) {
  // Real audio is 48 kHz stereo 16-bit; emit a downsampled envelope (10 Hz)
  // rather than one value per raw sample.
  const sampleRate = 10;
  const n = Math.max(1, Math.round(durationS * sampleRate));
  const values = Array.from({ length: n }, () => round(rand(40, 85), 2));
  return { values, sampleRate, unit: 'dB' };
}

/** PLACEHOLDER — replace with real gait analysis of the accelerometer CSV.
 *  Reads the real CSV to size the output correctly (100 Hz, t_s column). */
function processAccelerometer(csvPath, durationS) {
  let n = Math.max(1, Math.round(durationS * 100));
  try {
    if (csvPath && fs.existsSync(csvPath)) {
      const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
      if (lines.length > 1) n = lines.length - 1; // minus header
    }
  } catch { /* fall back to duration-based length */ }
  const footSpeed = {
    values: Array.from({ length: n }, () => round(rand(0, 180), 2)),
    sampleRate: 100,
    unit: 'cm/s',
  };
  const stepLengths = {
    values: Array.from({ length: Math.max(1, Math.round(durationS / 1.2)) }, () => round(rand(30, 80), 1)),
    unit: 'cm',
  };
  return { footSpeed, stepLengths };
}

/**
 * Turn a raw upload into the ExerciseData payload defined in openapi.yaml.
 * @param {object} p
 * @param {string} p.exerciseId
 * @param {string|null} p.startedAt  ISO-8601 (authoritative, from the Pi)
 * @param {string|null} p.endedAt    ISO-8601
 * @param {object} p.filePaths      { video?, audio?, accelerometer? } absolute paths
 */
function processRawRecording({ exerciseId, startedAt, endedAt, filePaths = {} }) {
  const durationS = startedAt && endedAt
    ? Math.max(1, (new Date(endedAt) - new Date(startedAt)) / 1000)
    : 10;

  const mouthOpening = processVideo(filePaths.video, durationS);
  const soundPressure = processAudio(filePaths.audio, durationS);
  const { footSpeed, stepLengths } = processAccelerometer(filePaths.accelerometer, durationS);

  const mv = mouthOpening.values.map((t) => t[0]);
  const mh = mouthOpening.values.map((t) => t[1]);

  return {
    exerciseId,
    startedAt,
    endedAt,
    mouthOpening,
    soundPressure,
    footSpeed,
    aggregates: {
      stepLengths,
      averages: {
        mouthOpeningVertical: round(avg(mv), 4),
        mouthOpeningHorizontal: round(avg(mh), 4),
        soundPressure: round(avg(soundPressure.values), 2),
        footSpeed: round(avg(footSpeed.values), 2),
        stepLength: round(avg(stepLengths.values), 2),
      },
      medians: {
        mouthOpeningVertical: round(median(mv), 4),
        mouthOpeningHorizontal: round(median(mh), 4),
        soundPressure: round(median(soundPressure.values), 2),
        footSpeed: round(median(footSpeed.values), 2),
        stepLength: round(median(stepLengths.values), 2),
      },
    },
  };
}

module.exports = { processRawRecording };
