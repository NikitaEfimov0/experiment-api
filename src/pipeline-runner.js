'use strict';

// Runs the Python feature pipeline (pipeline/extract_exercise.py) on an
// exercise's raw files and merges the REAL results into the stored
// ExerciseData. Runs in the background after a raw upload; if Python or its
// dependencies are missing it fails softly and the placeholder data stays.

const path = require('path');
const { execFile } = require('child_process');
const db = require('./db');

const PIPELINE_DIR = path.join(__dirname, '..', 'pipeline');
const SCRIPT = path.join(PIPELINE_DIR, 'extract_exercise.py');

const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (v, d) => +v.toFixed(d);

function runScript(pythonBin, exerciseDir, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      pythonBin,
      [SCRIPT, exerciseDir],
      { cwd: PIPELINE_DIR, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          // Surface the most useful line: the last non-empty stderr line
          // (usually the Python exception) rather than the exec boilerplate.
          const errLines = String(stderr).trim().split('\n').filter(Boolean);
          const detail = errLines.length ? errLines[errLines.length - 1] : err.message.split('\n')[0];
          return reject(new Error(`pipeline failed: ${detail}`));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`pipeline printed invalid JSON: ${String(stdout).slice(0, 500)}`));
        }
      }
    );
  });
}

/** Merge pipeline output into the exercise's stored ExerciseData. */
function mergeIntoData(data, result) {
  const merged = { ...data };

  if (result.mouthOpening && result.mouthOpening.values.length) {
    merged.mouthOpening = result.mouthOpening; // [vertical_mm, horizontal_mm]
    const mv = result.mouthOpening.values.map((t) => t[0]);
    const mh = result.mouthOpening.values.map((t) => t[1]);
    merged.aggregates.averages.mouthOpeningVertical = round(avg(mv), 4);
    merged.aggregates.averages.mouthOpeningHorizontal = round(avg(mh), 4);
    merged.aggregates.medians.mouthOpeningVertical = round(median(mv), 4);
    merged.aggregates.medians.mouthOpeningHorizontal = round(median(mh), 4);
  }
  if (result.soundPressure && result.soundPressure.values.length) {
    merged.soundPressure = result.soundPressure; // dBFS
    merged.aggregates.averages.soundPressure = round(avg(result.soundPressure.values), 2);
    merged.aggregates.medians.soundPressure = round(median(result.soundPressure.values), 2);
  }
  // footSpeed / stepLengths: no real gait-speed processor yet — keep as is.

  // Additive extension: the 14 clinical features + which signals are real.
  merged.features = result.features || {};
  merged.processedSignals = {
    mouthOpening: !!(result.mouthOpening && result.mouthOpening.values.length),
    soundPressure: !!(result.soundPressure && result.soundPressure.values.length),
    footSpeed: false,
  };
  return merged;
}

async function setPipelineStatus(pool, exerciseId, pipeline) {
  const { found, data } = await db.getExerciseData(pool, exerciseId);
  if (!found || !data) return null;
  const updated = { ...data, pipeline };
  await db.updateExerciseData(pool, exerciseId, updated);
  return updated;
}

/**
 * Fire-and-forget processing of one exercise. Never throws. Progress is
 * written into the stored data as `pipeline: {status, ...}` so the UI can
 * show "processing" and refresh when done.
 * @returns {Promise<boolean>} true if real data was stored.
 */
async function processExercise(pool, exerciseId, exerciseDir, { pythonBin = 'python3', timeoutMs = 10 * 60 * 1000 } = {}) {
  try {
    await setPipelineStatus(pool, exerciseId, { status: 'processing', startedAt: new Date().toISOString() });
    const result = await runScript(pythonBin, exerciseDir, timeoutMs);
    const { found, data } = await db.getExerciseData(pool, exerciseId);
    if (!found || !data) return false; // exercise deleted / cleared meanwhile
    const merged = mergeIntoData(data, result);
    merged.pipeline = { status: 'done', finishedAt: new Date().toISOString() };
    await db.updateExerciseData(pool, exerciseId, merged);
    console.log(`pipeline: real features stored for exercise ${exerciseId}`);
    return true;
  } catch (err) {
    const message = err.message.split('\n')[0];
    console.warn(`pipeline: falling back to placeholder data for ${exerciseId} — ${message}`);
    await setPipelineStatus(pool, exerciseId, {
      status: 'failed',
      error: message,
      finishedAt: new Date().toISOString(),
    }).catch(() => {});
    return false;
  }
}

module.exports = { processExercise, mergeIntoData, PIPELINE_DIR };
