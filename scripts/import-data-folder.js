'use strict';

// ---------------------------------------------------------------------------
// Rebuild experiment/exercise DB records from the raw files already sitting in
// DATA_DIR (default ./data). Each subfolder is named by its exerciseId and
// holds video.mp4 / audio.wav / accelerometer.csv — but the metadata that the
// admin UI reads lives only in Postgres. If the DB was recreated empty (e.g.
// switching to a fresh local database) the admin shows nothing even though the
// files are on disk. This script recreates the rows so they show up again.
//
// What is recoverable from disk and what is not:
//   - exerciseId ............ folder name (exact)
//   - duration .............. last t_s value in accelerometer.csv (exact)
//   - raw manifest .......... file names + byte sizes on disk (exact)
//   - processed ExerciseData  regenerated via src/processing.js (placeholder
//                             signals, same as a normal recording stop)
//   - patient number/age/... NOT on disk -> placeholder experiment metadata
//   - absolute wall-clock ... NOT on disk -> synthesized, staggered per folder
//
// Idempotent: re-running upserts the same exercise rows and reuses the single
// "imported" experiment rather than creating duplicates.
//
//   node --env-file=.env scripts/import-data-folder.js
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { processRawRecording } = require('../src/processing');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

// Synthetic base time for the (unrecoverable) absolute timestamps. Exercises
// are staggered 5 minutes apart so ordering in the admin is stable.
const BASE_TIME = Date.parse('2025-07-18T10:00:00.000Z');
const STAGGER_MS = 5 * 60 * 1000;

const MIME = { 'video.mp4': 'video/mp4', 'audio.wav': 'audio/wav', 'accelerometer.csv': 'text/csv' };
const PART_OF = { video: 'video.mp4', audio: 'audio.wav', accelerometer: 'accelerometer.csv' };

/** Duration in seconds from the accelerometer CSV's last t_s value. */
function durationFromCsv(csvPath) {
  try {
    const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    if (lines.length > 1) {
      const last = lines[lines.length - 1].split(',')[0];
      const t = parseFloat(last);
      if (Number.isFinite(t) && t > 0) return t;
    }
  } catch { /* fall through */ }
  return null;
}

function isExerciseDir(name) {
  // exerciseIds are UUIDs; skip dotfiles and anything else.
  return /^[0-9a-f-]{36}$/i.test(name) &&
    fs.statSync(path.join(DATA_DIR, name)).isDirectory();
}

async function findOrCreateImportedExperiment(pool) {
  const { rows } = await pool.query(
    `SELECT * FROM experiments WHERE properties->>'imported' = 'true' ORDER BY created_at LIMIT 1`
  );
  if (rows[0]) return rows[0].id;
  const exp = await db.createExperiment(pool, {
    patientNumber: 'imported',
    properties: {
      imported: 'true',
      source: 'data/ folder rebuild',
      note: 'Experiment-level metadata (patient number, age, height, weight) was not stored on disk and is a placeholder.',
    },
  });
  return exp.id;
}

async function upsertExercise(pool, experimentId, exerciseId, { startedAt, endedAt, data, raw, createdAt }) {
  await pool.query(
    `INSERT INTO exercises
       (id, experiment_id, properties, recording_status,
        recording_started_at, recording_ended_at, data, raw, created_at)
     VALUES ($1, $2, $3, 'stopped', $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       experiment_id = EXCLUDED.experiment_id,
       recording_status = 'stopped',
       recording_started_at = EXCLUDED.recording_started_at,
       recording_ended_at = EXCLUDED.recording_ended_at,
       data = EXCLUDED.data,
       raw = EXCLUDED.raw`,
    [
      exerciseId,
      experimentId,
      JSON.stringify({ imported: 'true' }),
      startedAt,
      endedAt,
      JSON.stringify(data),
      JSON.stringify(raw),
      createdAt,
    ]
  );
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) throw new Error(`DATA_DIR does not exist: ${DATA_DIR}`);

  const dirs = fs.readdirSync(DATA_DIR).filter(isExerciseDir).sort();
  if (dirs.length === 0) {
    console.log(`No exercise folders found under ${DATA_DIR}. Nothing to import.`);
    return;
  }

  const pool = db.createPool();
  await db.initSchema(pool);
  const experimentId = await findOrCreateImportedExperiment(pool);
  console.log(`Importing ${dirs.length} exercise folder(s) into experiment ${experimentId}\n`);

  let ok = 0;
  for (let i = 0; i < dirs.length; i++) {
    const exerciseId = dirs[i];
    const dir = path.join(DATA_DIR, exerciseId);

    // Build the raw manifest + file paths from whatever files are present.
    const files = {};
    const filePaths = {};
    for (const [part, fname] of Object.entries(PART_OF)) {
      const fp = path.join(dir, fname);
      if (fs.existsSync(fp)) {
        files[part] = { name: fname, bytes: fs.statSync(fp).size, mimeType: MIME[fname] };
        filePaths[part] = fp;
      }
    }
    if (Object.keys(files).length === 0) {
      console.log(`  - ${exerciseId}: no raw files, skipped`);
      continue;
    }

    const durationS = durationFromCsv(filePaths.accelerometer) || 10;
    const endedMs = BASE_TIME + i * STAGGER_MS;
    const startedAt = new Date(endedMs - durationS * 1000).toISOString();
    const endedAt = new Date(endedMs).toISOString();
    const createdAt = startedAt;

    const raw = { receivedAt: endedAt, files, metadata: { imported: true } };
    const data = processRawRecording({ exerciseId, startedAt, endedAt, filePaths });

    await upsertExercise(pool, experimentId, exerciseId, { startedAt, endedAt, data, raw, createdAt });
    ok++;
    console.log(`  ✓ ${exerciseId}  (${durationS.toFixed(1)}s, parts: ${Object.keys(files).join('/')})`);
  }

  console.log(`\nDone: ${ok}/${dirs.length} exercise(s) imported under 1 experiment.`);
  console.log('Reprocess real signals later with: POST /exercises/{id}/data/reprocess');
  await pool.end();
}

main().catch((err) => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
