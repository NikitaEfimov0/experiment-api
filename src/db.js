'use strict';

const { Pool } = require('pg');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Pool creation & schema
// ---------------------------------------------------------------------------

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS experiments (
    id             TEXT PRIMARY KEY,
    patient_number TEXT,
    height         DOUBLE PRECISION,
    age            INTEGER,
    weight         DOUBLE PRECISION,
    properties     JSONB NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS exercises (
    id                   TEXT PRIMARY KEY,
    experiment_id        TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
    properties           JSONB NOT NULL,
    recording_status     TEXT NOT NULL,
    recording_started_at TIMESTAMPTZ,
    recording_ended_at   TIMESTAMPTZ,
    data                 JSONB,
    raw                  JSONB,
    created_at           TIMESTAMPTZ NOT NULL
  )`,
];

// Additive migrations for databases created by earlier versions.
const MIGRATION_STATEMENTS = [
  `ALTER TABLE exercises ADD COLUMN IF NOT EXISTS raw JSONB`,
];

function createPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Provide a PostgreSQL connection string, e.g. ' +
        'postgresql://user:password@host:5432/dbname'
    );
  }
  // Railway's internal network does not need SSL; the public proxy does.
  // Set PGSSL=require (or use ?sslmode=require in the URL) for public endpoints.
  const ssl =
    process.env.PGSSL === 'require' || /sslmode=require/.test(connectionString)
      ? { rejectUnauthorized: false }
      : undefined;
  return new Pool({ connectionString, ssl });
}

async function initSchema(pool) {
  for (const stmt of SCHEMA_STATEMENTS) {
    await pool.query(stmt);
  }
  for (const stmt of MIGRATION_STATEMENTS) {
    try {
      await pool.query(stmt);
    } catch {
      // Some engines (e.g. pg-mem in tests) don't support ADD COLUMN IF NOT
      // EXISTS; the column already exists via CREATE TABLE above.
    }
  }
}

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

const uuid = () => crypto.randomUUID();
const iso = (d) => (d == null ? null : new Date(d).toISOString());

function mapExperiment(r) {
  return {
    id: r.id,
    patientNumber: r.patient_number,
    height: r.height,
    age: r.age,
    weight: r.weight,
    createdAt: iso(r.created_at),
    properties: r.properties || {},
  };
}

function mapExercise(r) {
  return {
    id: r.id,
    experimentId: r.experiment_id,
    createdAt: iso(r.created_at),
    recordingStatus: r.recording_status,
    hasData: r.data != null,
    recordingStartedAt: iso(r.recording_started_at),
    recordingEndedAt: iso(r.recording_ended_at),
    properties: r.properties || {},
    // Additive extension (not in the published spec): whether raw sensor
    // files from the recording agent are stored for this exercise.
    hasRawData: r.raw != null,
  };
}

// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------

async function createExperiment(pool, input) {
  const { rows } = await pool.query(
    `INSERT INTO experiments (id, patient_number, height, age, weight, properties, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      uuid(),
      input.patientNumber ?? null,
      input.height ?? null,
      input.age ?? null,
      input.weight ?? null,
      JSON.stringify(input.properties ?? {}),
      new Date().toISOString(),
    ]
  );
  return mapExperiment(rows[0]);
}

async function listExperiments(pool, page, pageSize) {
  const { rows: countRows } = await pool.query('SELECT COUNT(*) AS n FROM experiments');
  const total = Number(countRows[0].n);
  const { rows } = await pool.query(
    `SELECT * FROM experiments ORDER BY created_at DESC, id LIMIT $1 OFFSET $2`,
    [pageSize, (page - 1) * pageSize]
  );
  return { items: rows.map(mapExperiment), page, pageSize, total };
}

async function getExperiment(pool, id) {
  const { rows } = await pool.query('SELECT * FROM experiments WHERE id = $1', [id]);
  return rows[0] ? mapExperiment(rows[0]) : null;
}

async function updateExperiment(pool, id, input) {
  const sets = [];
  const values = [];
  const add = (col, val) => {
    values.push(val);
    sets.push(`${col} = $${values.length}`);
  };
  if ('patientNumber' in input) add('patient_number', input.patientNumber);
  if ('height' in input) add('height', input.height);
  if ('age' in input) add('age', input.age);
  if ('weight' in input) add('weight', input.weight);
  if ('properties' in input) add('properties', JSON.stringify(input.properties ?? {}));
  if (sets.length === 0) return getExperiment(pool, id);
  values.push(id);
  const { rows } = await pool.query(
    `UPDATE experiments SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  return rows[0] ? mapExperiment(rows[0]) : null;
}

async function deleteExperiment(pool, id) {
  const { rowCount } = await pool.query('DELETE FROM experiments WHERE id = $1', [id]);
  return rowCount > 0;
}

// ---------------------------------------------------------------------------
// Exercises
// ---------------------------------------------------------------------------

async function createExercise(pool, experimentId, input) {
  const { rows } = await pool.query(
    `INSERT INTO exercises (id, experiment_id, properties, recording_status, created_at)
     VALUES ($1, $2, $3, 'idle', $4)
     RETURNING *`,
    [uuid(), experimentId, JSON.stringify(input.properties ?? {}), new Date().toISOString()]
  );
  return mapExercise(rows[0]);
}

async function listExercisesOfExperiment(pool, experimentId) {
  const { rows } = await pool.query(
    'SELECT * FROM exercises WHERE experiment_id = $1 ORDER BY created_at DESC, id',
    [experimentId]
  );
  return rows.map(mapExercise);
}

async function listExercises(pool, page, pageSize) {
  const { rows: countRows } = await pool.query('SELECT COUNT(*) AS n FROM exercises');
  const total = Number(countRows[0].n);
  const { rows } = await pool.query(
    'SELECT * FROM exercises ORDER BY created_at DESC, id LIMIT $1 OFFSET $2',
    [pageSize, (page - 1) * pageSize]
  );
  return { items: rows.map(mapExercise), page, pageSize, total };
}

async function getExercise(pool, id) {
  const { rows } = await pool.query('SELECT * FROM exercises WHERE id = $1', [id]);
  return rows[0] ? mapExercise(rows[0]) : null;
}

async function deleteExercise(pool, id) {
  const { rowCount } = await pool.query('DELETE FROM exercises WHERE id = $1', [id]);
  return rowCount > 0;
}

// ---------------------------------------------------------------------------
// Recording & data
// ---------------------------------------------------------------------------

async function startRecording(pool, id, startedAt) {
  const { rows } = await pool.query(
    `UPDATE exercises
     SET recording_status = 'recording', recording_started_at = $2, recording_ended_at = NULL
     WHERE id = $1
     RETURNING *`,
    [id, startedAt ?? new Date().toISOString()]
  );
  return rows[0] ? mapExercise(rows[0]) : null;
}

async function stopRecording(pool, id, data, endedAt) {
  const { rows } = await pool.query(
    `UPDATE exercises
     SET recording_status = 'stopped', recording_ended_at = $2, data = $3
     WHERE id = $1
     RETURNING *`,
    [id, endedAt ?? new Date().toISOString(), JSON.stringify(data)]
  );
  return rows[0] ? mapExercise(rows[0]) : null;
}

/** Mark an exercise stopped WITHOUT touching data/raw. Used in Pi-agent mode,
 *  where data arrives separately via the raw-ingestion route. */
async function markStopped(pool, id, endedAt) {
  const { rows } = await pool.query(
    `UPDATE exercises
     SET recording_status = 'stopped', recording_ended_at = $2
     WHERE id = $1
     RETURNING *`,
    [id, endedAt ?? new Date().toISOString()]
  );
  return rows[0] ? mapExercise(rows[0]) : null;
}

/** Store a raw upload from the recording agent: raw manifest + processed data,
 *  authoritative timestamps, status -> stopped. */
async function saveRawRecording(pool, id, { raw, data, startedAt, endedAt }) {
  const { rows } = await pool.query(
    `UPDATE exercises
     SET raw = $2, data = $3, recording_status = 'stopped',
         recording_started_at = COALESCE($4, recording_started_at),
         recording_ended_at = COALESCE($5, recording_ended_at)
     WHERE id = $1
     RETURNING *`,
    [id, JSON.stringify(raw), JSON.stringify(data), startedAt ?? null, endedAt ?? null]
  );
  return rows[0] ? mapExercise(rows[0]) : null;
}

async function getRawManifest(pool, id) {
  const { rows } = await pool.query('SELECT raw FROM exercises WHERE id = $1', [id]);
  if (!rows[0]) return { found: false, raw: null };
  return { found: true, raw: rows[0].raw };
}

async function getExerciseData(pool, id) {
  const { rows } = await pool.query('SELECT data FROM exercises WHERE id = $1', [id]);
  if (!rows[0]) return { found: false, data: null };
  return { found: true, data: rows[0].data };
}

async function clearExerciseData(pool, id) {
  const { rows } = await pool.query(
    `UPDATE exercises
     SET data = NULL, raw = NULL, recording_status = 'idle',
         recording_started_at = NULL, recording_ended_at = NULL
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return rows[0] ? mapExercise(rows[0]) : null;
}

module.exports = {
  createPool,
  initSchema,
  createExperiment,
  listExperiments,
  getExperiment,
  updateExperiment,
  deleteExperiment,
  createExercise,
  listExercisesOfExperiment,
  listExercises,
  getExercise,
  deleteExercise,
  startRecording,
  stopRecording,
  markStopped,
  saveRawRecording,
  getRawManifest,
  getExerciseData,
  clearExerciseData,
};
