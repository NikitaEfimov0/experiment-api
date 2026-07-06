'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const db = require('./db');
const { generateData } = require('./stub-data');
const { createPiAgent, PiAgentError } = require('./pi-agent');
const { processRawRecording } = require('./processing');

const SPEC_PATH = path.join(__dirname, '..', 'openapi.yaml');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const RAW_PARTS = ['video', 'audio', 'accelerometer'];

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateExperimentInput(body, { partial } = {}) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object.';
  }
  if ('patientNumber' in body && body.patientNumber != null && typeof body.patientNumber !== 'string') {
    return '"patientNumber" must be a string.';
  }
  for (const key of ['height', 'weight']) {
    if (key in body && body[key] != null && typeof body[key] !== 'number') {
      return `"${key}" must be a number.`;
    }
  }
  if ('age' in body && body.age != null && !Number.isInteger(body.age)) {
    return '"age" must be an integer.';
  }
  return validateProperties(body);
}

function validateProperties(body) {
  if (!('properties' in body) || body.properties == null) return null;
  const p = body.properties;
  if (typeof p !== 'object' || Array.isArray(p)) {
    return '"properties" must be an object with string values.';
  }
  for (const [k, v] of Object.entries(p)) {
    if (typeof v !== 'string') {
      return `"properties.${k}" must be a string.`;
    }
  }
  return null;
}

function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize, 10) || 20));
  return { page, pageSize };
}

// ---------------------------------------------------------------------------
// App factory (pool injected for testability)
// ---------------------------------------------------------------------------

function buildApp(pool, options = {}) {
  const {
    // Raspberry Pi recording agent, e.g. http://raspberrypi.local:8090.
    // When unset the server runs in STUB mode (data generated on stop).
    piAgentUrl = process.env.PI_AGENT_URL || null,
    piStartTimeoutMs = parseInt(process.env.PI_START_TIMEOUT_MS, 10) || 20000,
    piStopTimeoutMs = parseInt(process.env.PI_STOP_TIMEOUT_MS, 10) || 60000,
    // Optional bearer token the Pi must present on the raw-ingestion route.
    ingestToken = process.env.INGEST_TOKEN || null,
    // Where raw uploaded files are stored (attach a Railway Volume here).
    dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  } = options;

  const pi = piAgentUrl
    ? createPiAgent({ baseUrl: piAgentUrl, startTimeoutMs: piStartTimeoutMs, stopTimeoutMs: piStopTimeoutMs })
    : null;

  fs.mkdirSync(dataDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        const dir = path.join(dataDir, req.params.exerciseId);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        // Keep the part name as file name + original extension (video.mp4, ...).
        const ext = path.extname(file.originalname || '') || '';
        cb(null, file.fieldname + ext);
      },
    }),
    limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB per file
  });

  const rawDirOf = (exerciseId) => path.join(dataDir, exerciseId);
  const deleteRawFiles = (exerciseId) => {
    fs.rmSync(rawDirOf(exerciseId), { recursive: true, force: true });
  };

  const app = express();
  app.use(express.json());
  app.use(cors());

  const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

  // ----- Documentation & admin UI -----------------------------------------

  app.get('/openapi.yaml', (_req, res) => {
    res.type('text/yaml').sendFile(SPEC_PATH);
  });

  app.get('/docs', (_req, res) => {
    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
  <head>
    <title>Experiment API — Documentation</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>body { margin: 0; padding: 0; }</style>
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.yaml"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`);
  });

  app.get('/', (_req, res) => res.redirect('/admin'));
  app.get('/admin', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
  app.use(express.static(PUBLIC_DIR));

  // ----- Experiments --------------------------------------------------------

  app.post('/experiments', wrap(async (req, res) => {
    const error = validateExperimentInput(req.body ?? {});
    if (error) return res.status(400).json({ error });
    const experiment = await db.createExperiment(pool, req.body ?? {});
    res.status(201).json(experiment);
  }));

  app.get('/experiments', wrap(async (req, res) => {
    const { page, pageSize } = parsePagination(req.query);
    res.json(await db.listExperiments(pool, page, pageSize));
  }));

  app.get('/experiments/:experimentId', wrap(async (req, res) => {
    const experiment = await db.getExperiment(pool, req.params.experimentId);
    if (!experiment) return res.status(404).json({ error: 'Experiment not found' });
    res.json(experiment);
  }));

  app.patch('/experiments/:experimentId', wrap(async (req, res) => {
    const error = validateExperimentInput(req.body ?? {}, { partial: true });
    if (error) return res.status(400).json({ error });
    const experiment = await db.updateExperiment(pool, req.params.experimentId, req.body ?? {});
    if (!experiment) return res.status(404).json({ error: 'Experiment not found' });
    res.json(experiment);
  }));

  app.delete('/experiments/:experimentId', wrap(async (req, res) => {
    const exercises = await db.listExercisesOfExperiment(pool, req.params.experimentId).catch(() => []);
    const deleted = await db.deleteExperiment(pool, req.params.experimentId);
    if (!deleted) return res.status(404).json({ error: 'Experiment not found' });
    for (const ex of exercises) deleteRawFiles(ex.id);
    res.status(204).end();
  }));

  // ----- Exercises ----------------------------------------------------------

  app.post('/experiments/:experimentId/exercises', wrap(async (req, res) => {
    const experiment = await db.getExperiment(pool, req.params.experimentId);
    if (!experiment) return res.status(404).json({ error: 'Experiment not found' });
    const error = validateProperties(req.body ?? {});
    if (error) return res.status(400).json({ error });
    const exercise = await db.createExercise(pool, experiment.id, req.body ?? {});
    res.status(201).json(exercise);
  }));

  app.get('/experiments/:experimentId/exercises', wrap(async (req, res) => {
    const experiment = await db.getExperiment(pool, req.params.experimentId);
    if (!experiment) return res.status(404).json({ error: 'Experiment not found' });
    res.json(await db.listExercisesOfExperiment(pool, experiment.id));
  }));

  app.get('/exercises', wrap(async (req, res) => {
    const { page, pageSize } = parsePagination(req.query);
    res.json(await db.listExercises(pool, page, pageSize));
  }));

  app.get('/exercises/:exerciseId', wrap(async (req, res) => {
    const exercise = await db.getExercise(pool, req.params.exerciseId);
    if (!exercise) return res.status(404).json({ error: 'Exercise not found' });
    res.json(exercise);
  }));

  app.delete('/exercises/:exerciseId', wrap(async (req, res) => {
    const deleted = await db.deleteExercise(pool, req.params.exerciseId);
    if (!deleted) return res.status(404).json({ error: 'Exercise not found' });
    deleteRawFiles(req.params.exerciseId);
    res.status(204).end();
  }));

  // ----- Recording control --------------------------------------------------
  // With PI_AGENT_URL set, start/stop are delegated to the Raspberry Pi
  // recording agent (INTEGRATION.md). Without it, the server runs in stub
  // mode and generates data itself on stop.

  app.post('/exercises/:exerciseId/recording/start', wrap(async (req, res) => {
    const exercise = await db.getExercise(pool, req.params.exerciseId);
    if (!exercise) return res.status(404).json({ error: 'Exercise not found' });
    if (exercise.hasData) {
      return res.status(409).json({ error: 'Exercise already has data. Clear it before recording again.' });
    }
    if (exercise.recordingStatus === 'recording') {
      return res.status(409).json({ error: 'Recording is already in progress.' });
    }
    let startedAt; // Pi's startedAt is authoritative (camera warm-up takes 1-4s)
    if (pi) {
      const status = await pi.startRecording(exercise.id);
      startedAt = status.startedAt;
    }
    res.json(await db.startRecording(pool, exercise.id, startedAt));
  }));

  app.post('/exercises/:exerciseId/recording/stop', wrap(async (req, res) => {
    const exercise = await db.getExercise(pool, req.params.exerciseId);
    if (!exercise) return res.status(404).json({ error: 'Exercise not found' });
    if (exercise.recordingStatus !== 'recording') {
      return res.status(409).json({ error: 'Exercise is not currently recording.' });
    }
    if (pi) {
      // The Pi finalises files and uploads them to POST .../data/raw *before*
      // responding here, so by the time we get the summary the raw route has
      // usually already stored data and marked the exercise stopped.
      const summary = await pi.stopRecording();
      const updated = await db.markStopped(pool, exercise.id, summary.endedAt);
      if (summary.upload && summary.upload.ok === false) {
        console.warn(`Pi upload failed for exercise ${exercise.id}; files kept on the Pi for retry.`);
      }
      return res.json(updated);
    }
    const endedAt = new Date().toISOString();
    const data = generateData(exercise.id, exercise.recordingStartedAt, endedAt);
    res.json(await db.stopRecording(pool, exercise.id, data, endedAt));
  }));

  // Recording agent status passthrough for the admin UI (additive, not in spec).
  app.get('/agent/status', wrap(async (_req, res) => {
    if (!pi) return res.json({ configured: false, mode: 'stub' });
    try {
      const status = await pi.status();
      res.json({ configured: true, mode: 'pi', reachable: true, agent: status });
    } catch (err) {
      res.json({ configured: true, mode: 'pi', reachable: false, error: err.message });
    }
  }));

  // ----- Raw ingestion (called by the Pi agent after stop) -------------------
  // POST /exercises/{exerciseId}/data/raw — multipart/form-data with text
  // fields exerciseId, startedAt, endedAt, metadata (JSON) and file parts
  // video (mp4), audio (wav), accelerometer (csv). Any 2xx = success for the
  // Pi; on non-2xx it keeps the files locally and can retry.

  const requireIngestAuth = (req, res, next) => {
    if (!ingestToken) return next();
    const header = req.headers.authorization || '';
    if (header === `Bearer ${ingestToken}`) return next();
    return res.status(401).json({ error: 'Invalid or missing bearer token' });
  };

  const rawUpload = upload.fields(RAW_PARTS.map((name) => ({ name, maxCount: 1 })));

  app.post('/exercises/:exerciseId/data/raw', requireIngestAuth, wrap(async (req, res) => {
    const exercise = await db.getExercise(pool, req.params.exerciseId);
    if (!exercise) return res.status(404).json({ error: 'Exercise not found' });

    await new Promise((resolve, reject) => rawUpload(req, res, (err) => (err ? reject(err) : resolve())));

    const body = req.body || {};
    if (body.exerciseId && body.exerciseId !== exercise.id) {
      deleteRawFiles(exercise.id);
      return res.status(400).json({ error: 'exerciseId field does not match the URL.' });
    }
    let metadata = {};
    try {
      metadata = body.metadata ? JSON.parse(body.metadata) : {};
    } catch {
      return res.status(400).json({ error: '"metadata" field is not valid JSON.' });
    }

    const files = {};
    const filePaths = {};
    for (const part of RAW_PARTS) {
      const f = req.files && req.files[part] && req.files[part][0];
      if (f) {
        files[part] = { name: f.filename, bytes: f.size, mimeType: f.mimetype };
        filePaths[part] = f.path;
      }
    }
    if (Object.keys(files).length === 0) {
      return res.status(400).json({ error: `No file parts received. Expected one of: ${RAW_PARTS.join(', ')}.` });
    }

    const startedAt = body.startedAt || exercise.recordingStartedAt;
    const endedAt = body.endedAt || new Date().toISOString();
    const raw = { receivedAt: new Date().toISOString(), files, metadata };
    const data = processRawRecording({ exerciseId: exercise.id, startedAt, endedAt, filePaths });

    const updated = await db.saveRawRecording(pool, exercise.id, { raw, data, startedAt, endedAt });
    res.status(201).json({ ok: true, exercise: updated });
  }));

  // Raw manifest + file download (additive, for the admin UI / researchers).
  app.get('/exercises/:exerciseId/data/raw', wrap(async (req, res) => {
    const { found, raw } = await db.getRawManifest(pool, req.params.exerciseId);
    if (!found) return res.status(404).json({ error: 'Exercise not found' });
    if (!raw) return res.status(404).json({ error: 'Exercise has no raw data' });
    res.json(raw);
  }));

  app.get('/exercises/:exerciseId/data/raw/:part', wrap(async (req, res) => {
    const { part } = req.params;
    if (!RAW_PARTS.includes(part)) return res.status(404).json({ error: 'Unknown raw part' });
    const { found, raw } = await db.getRawManifest(pool, req.params.exerciseId);
    if (!found) return res.status(404).json({ error: 'Exercise not found' });
    if (!raw || !raw.files || !raw.files[part]) return res.status(404).json({ error: 'No such raw file' });
    const filePath = path.join(rawDirOf(req.params.exerciseId), raw.files[part].name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Raw file missing from storage' });
    res.download(filePath, raw.files[part].name);
  }));

  // ----- Data ---------------------------------------------------------------

  app.get('/exercises/:exerciseId/data', wrap(async (req, res) => {
    const { found, data } = await db.getExerciseData(pool, req.params.exerciseId);
    if (!found) return res.status(404).json({ error: 'Exercise not found' });
    if (!data) return res.status(404).json({ error: 'Exercise has no data yet' });
    res.json(data);
  }));

  app.delete('/exercises/:exerciseId/data', wrap(async (req, res) => {
    const exercise = await db.clearExerciseData(pool, req.params.exerciseId);
    if (!exercise) return res.status(404).json({ error: 'Exercise not found' });
    deleteRawFiles(req.params.exerciseId);
    res.status(204).end();
  }));

  // ----- Error handling -----------------------------------------------------

  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body is not valid JSON.' });
    }
    if (err instanceof PiAgentError) {
      return res.status(err.status || 502).json({ error: err.message });
    }
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { buildApp };
