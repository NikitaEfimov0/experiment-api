'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const db = require('./db');
const { generateData } = require('./stub-data');

const SPEC_PATH = path.join(__dirname, '..', 'openapi.yaml');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

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

function buildApp(pool) {
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
    const deleted = await db.deleteExperiment(pool, req.params.experimentId);
    if (!deleted) return res.status(404).json({ error: 'Experiment not found' });
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
    res.status(204).end();
  }));

  // ----- Recording control --------------------------------------------------

  app.post('/exercises/:exerciseId/recording/start', wrap(async (req, res) => {
    const exercise = await db.getExercise(pool, req.params.exerciseId);
    if (!exercise) return res.status(404).json({ error: 'Exercise not found' });
    if (exercise.hasData) {
      return res.status(409).json({ error: 'Exercise already has data. Clear it before recording again.' });
    }
    if (exercise.recordingStatus === 'recording') {
      return res.status(409).json({ error: 'Recording is already in progress.' });
    }
    res.json(await db.startRecording(pool, exercise.id));
  }));

  app.post('/exercises/:exerciseId/recording/stop', wrap(async (req, res) => {
    const exercise = await db.getExercise(pool, req.params.exerciseId);
    if (!exercise) return res.status(404).json({ error: 'Exercise not found' });
    if (exercise.recordingStatus !== 'recording') {
      return res.status(409).json({ error: 'Exercise is not currently recording.' });
    }
    const endedAt = new Date().toISOString();
    const data = generateData(exercise.id, exercise.recordingStartedAt, endedAt);
    res.json(await db.stopRecording(pool, exercise.id, data));
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
    res.status(204).end();
  }));

  // ----- Error handling -----------------------------------------------------

  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body is not valid JSON.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { buildApp };
