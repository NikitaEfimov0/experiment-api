'use strict';

// ---------------------------------------------------------------------------
// Run the feature pipeline over every exercise that has raw files, SEQUENTIALLY
// and in-process (no HTTP). This is the reliable way to backfill real signals
// for many exercises at once: the server's own reprocess endpoint kicks off
// background jobs that saturate the CPU, so firing it in a loop makes the
// polling requests time out. Here each exercise finishes before the next
// starts, reusing the exact production code path (pipeline-runner).
//
//   node --env-file=.env scripts/reprocess-all.js
//
// Requires PIPELINE_PYTHON to point at the pipeline venv (set in .env).
// ---------------------------------------------------------------------------

const path = require('path');
const db = require('../src/db');
const pipelineRunner = require('../src/pipeline-runner');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const pythonBin = process.env.PIPELINE_PYTHON || 'python3';

async function main() {
  const pool = db.createPool();
  // Pull every exercise that has raw files stored.
  const { rows } = await pool.query(
    `SELECT id FROM exercises WHERE raw IS NOT NULL ORDER BY created_at`
  );
  if (rows.length === 0) {
    console.log('No exercises with raw files. Nothing to reprocess.');
    await pool.end();
    return;
  }

  console.log(`Reprocessing ${rows.length} exercise(s) with ${pythonBin}\n`);
  let ok = 0;
  for (let i = 0; i < rows.length; i++) {
    const id = rows[i];
    const dir = path.join(DATA_DIR, id.id);
    process.stdout.write(`  [${i + 1}/${rows.length}] ${id.id.slice(0, 8)} ... `);
    const real = await pipelineRunner.processExercise(pool, id.id, dir, { pythonBin });
    if (real) {
      const { data } = await db.getExerciseData(pool, id.id);
      const f = data.features || {};
      const ps = data.processedSignals || {};
      console.log(
        `done (mouth=${ps.mouthOpening} sound=${ps.soundPressure} foot=${ps.footSpeed}, ` +
          `steps=${f.step_count}, video_detection=${(f.video_detection_rate ?? 0).toFixed?.(3)})`
      );
      ok++;
    } else {
      console.log('FAILED (kept placeholder — see server-style warning above)');
    }
  }
  console.log(`\nDone: ${ok}/${rows.length} exercise(s) now have real signals.`);
  await pool.end();
}

main().catch((err) => {
  console.error('reprocess-all failed:', err.message);
  process.exit(1);
});
