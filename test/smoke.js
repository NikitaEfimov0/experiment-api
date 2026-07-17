'use strict';

// End-to-end smoke test against an in-memory Postgres (pg-mem).
// Run with: npm test
const assert = require('assert');
const { newDb } = require('pg-mem');
const { buildApp } = require('../src/app');
const db = require('../src/db');

async function main() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await db.initSchema(pool);

  const app = buildApp(pool);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, body, expectStatus) => {
    const res = await fetch(base + path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    assert.strictEqual(res.status, expectStatus, `${method} ${path} -> ${res.status}, expected ${expectStatus}`);
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    return ct.includes('json') ? res.json() : res.text();
  };

  let passed = 0;
  const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

  // --- Experiments ---------------------------------------------------------
  const exp = await call('POST', '/experiments', {
    patientNumber: 'P-0042', height: 176, age: 63, weight: 78.5,
    properties: { room: 'Lab 2' },
  }, 201);
  assert.ok(exp.id && exp.createdAt);
  assert.strictEqual(exp.patientNumber, 'P-0042');
  assert.deepStrictEqual(exp.properties, { room: 'Lab 2' });
  ok('POST /experiments creates experiment');

  await call('POST', '/experiments', { age: 'old' }, 400);
  ok('POST /experiments validates body');

  const list = await call('GET', '/experiments?page=1&pageSize=10', undefined, 200);
  assert.strictEqual(list.total, 1);
  assert.strictEqual(list.items.length, 1);
  assert.strictEqual(list.page, 1);
  ok('GET /experiments paginates');

  const got = await call('GET', `/experiments/${exp.id}`, undefined, 200);
  assert.strictEqual(got.id, exp.id);
  ok('GET /experiments/{id}');
  await call('GET', '/experiments/nope', undefined, 404);
  ok('GET /experiments/{id} 404');

  const patched = await call('PATCH', `/experiments/${exp.id}`, { weight: 80, properties: { room: 'Lab 3', notes: 'x' } }, 200);
  assert.strictEqual(patched.weight, 80);
  assert.strictEqual(patched.patientNumber, 'P-0042'); // untouched
  assert.deepStrictEqual(patched.properties, { room: 'Lab 3', notes: 'x' });
  ok('PATCH /experiments/{id} partial update');

  // --- Exercises -------------------------------------------------------------
  const ex = await call('POST', `/experiments/${exp.id}/exercises`, { properties: { type: 'walking' } }, 201);
  assert.strictEqual(ex.experimentId, exp.id);
  assert.strictEqual(ex.recordingStatus, 'idle');
  assert.strictEqual(ex.hasData, false);
  assert.strictEqual(ex.recordingStartedAt, null);
  ok('POST /experiments/{id}/exercises');

  await call('POST', '/experiments/nope/exercises', {}, 404);
  ok('POST exercises 404 for unknown experiment');

  const nested = await call('GET', `/experiments/${exp.id}/exercises`, undefined, 200);
  assert.strictEqual(nested.length, 1);
  ok('GET /experiments/{id}/exercises');

  const flat = await call('GET', '/exercises', undefined, 200);
  assert.strictEqual(flat.total, 1);
  ok('GET /exercises paginated');

  const gotEx = await call('GET', `/exercises/${ex.id}`, undefined, 200);
  assert.strictEqual(gotEx.id, ex.id);
  ok('GET /exercises/{id}');

  // --- Recording lifecycle ---------------------------------------------------
  await call('GET', `/exercises/${ex.id}/data`, undefined, 404);
  ok('GET data 404 before recording');

  const started = await call('POST', `/exercises/${ex.id}/recording/start`, undefined, 200);
  assert.strictEqual(started.recordingStatus, 'recording');
  assert.ok(started.recordingStartedAt);
  ok('POST recording/start');

  await call('POST', `/exercises/${ex.id}/recording/start`, undefined, 409);
  ok('start while recording -> 409');

  const stopped = await call('POST', `/exercises/${ex.id}/recording/stop`, undefined, 200);
  assert.strictEqual(stopped.recordingStatus, 'stopped');
  assert.strictEqual(stopped.hasData, true);
  assert.ok(stopped.recordingEndedAt);
  ok('POST recording/stop generates data');

  await call('POST', `/exercises/${ex.id}/recording/stop`, undefined, 409);
  ok('stop while not recording -> 409');
  await call('POST', `/exercises/${ex.id}/recording/start`, undefined, 409);
  ok('start with existing data -> 409');

  const data = await call('GET', `/exercises/${ex.id}/data`, undefined, 200);
  assert.strictEqual(data.exerciseId, ex.id);
  assert.ok(Array.isArray(data.mouthOpening.values) && data.mouthOpening.values[0].length === 2);
  assert.strictEqual(data.soundPressure.unit, 'dB');
  assert.strictEqual(data.footSpeed.unit, 'cm/s');
  assert.ok(typeof data.aggregates.averages.stepLength === 'number');
  assert.ok(typeof data.aggregates.medians.soundPressure === 'number');
  ok('GET data matches spec shape');

  await call('DELETE', `/exercises/${ex.id}/data`, undefined, 204);
  const cleared = await call('GET', `/exercises/${ex.id}`, undefined, 200);
  assert.strictEqual(cleared.hasData, false);
  assert.strictEqual(cleared.recordingStatus, 'idle');
  ok('DELETE data clears and resets');

  const restart = await call('POST', `/exercises/${ex.id}/recording/start`, undefined, 200);
  assert.strictEqual(restart.recordingStatus, 'recording');
  ok('can re-record after clear');
  await call('POST', `/exercises/${ex.id}/recording/stop`, undefined, 200);

  // --- Cascade delete ----------------------------------------------------------
  await call('DELETE', `/exercises/${ex.id}`, undefined, 204);
  await call('GET', `/exercises/${ex.id}`, undefined, 404);
  ok('DELETE /exercises/{id}');

  const ex2 = await call('POST', `/experiments/${exp.id}/exercises`, {}, 201);
  await call('DELETE', `/experiments/${exp.id}`, undefined, 204);
  await call('GET', `/experiments/${exp.id}`, undefined, 404);
  await call('GET', `/exercises/${ex2.id}`, undefined, 404);
  ok('DELETE experiment cascades to exercises');

  // --- Docs & admin ---------------------------------------------------------
  const spec = await call('GET', '/openapi.yaml', undefined, 200);
  assert.ok(String(spec).includes('openapi: 3.0.3'));
  ok('GET /openapi.yaml');
  const docs = await call('GET', '/docs', undefined, 200);
  assert.ok(String(docs).includes('api-reference'));
  ok('GET /docs');
  const admin = await call('GET', '/admin', undefined, 200);
  assert.ok(String(admin).includes('Experiment Admin'));
  ok('GET /admin serves UI');

  server.close();

  // =========================================================================
  // Pi-agent mode: fake Raspberry Pi agent per INTEGRATION.md
  // =========================================================================
  console.log('\nPi-agent mode:');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const express = require('express');

  const TOKEN = 'test-token-123';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-raw-'));

  const mem2 = newDb();
  const { Pool: Pool2 } = mem2.adapters.createPg();
  const pool2 = new Pool2();
  await db.initSchema(pool2);

  // Fake Pi agent -----------------------------------------------------------
  let piState = { state: 'idle', exerciseId: null, startedAt: null, endedAt: null };
  let serverBaseUrl = null; // set once the API server is listening
  const fakePi = express();
  fakePi.use(express.json());
  fakePi.get('/status', (_req, res) => res.json({ ...piState, mock: true }));
  fakePi.post('/recording/start', (req, res) => {
    if (piState.state === 'recording') return res.status(409).json({ error: 'already recording' });
    if (!req.body.exerciseId) return res.status(400).json({ error: 'missing exerciseId' });
    piState = { state: 'recording', exerciseId: req.body.exerciseId, startedAt: new Date().toISOString(), endedAt: null };
    res.json({ ...piState, mock: true });
  });
  fakePi.post('/recording/stop', async (_req, res) => {
    if (piState.state !== 'recording') return res.status(409).json({ error: 'not recording' });
    piState.state = 'idle';
    piState.endedAt = new Date().toISOString();
    // Upload raw files to the server BEFORE responding (like the real agent).
    const fd = new FormData();
    fd.append('exerciseId', piState.exerciseId);
    fd.append('startedAt', piState.startedAt);
    fd.append('endedAt', piState.endedAt);
    fd.append('metadata', JSON.stringify({ results: { video: { ok: true }, audio: { ok: true }, accelerometer: { ok: true } }, mock: true }));
    fd.append('video', new Blob([Buffer.from('fake-mp4')], { type: 'video/mp4' }), 'video.mp4');
    fd.append('audio', new Blob([Buffer.from('fake-wav')], { type: 'audio/wav' }), 'audio.wav');
    const csv = 't_s,ax_g,ay_g,az_g,gx_dps,gy_dps,gz_dps,temp_c\n' +
      Array.from({ length: 250 }, (_, i) => `${(i / 100).toFixed(2)},0,0,1,0,0,0,25`).join('\n');
    fd.append('accelerometer', new Blob([csv], { type: 'text/csv' }), 'mpu6050.csv');
    const up = await fetch(`${serverBaseUrl}/exercises/${piState.exerciseId}/data/raw`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: fd,
    });
    res.json({
      exerciseId: piState.exerciseId,
      startedAt: piState.startedAt,
      endedAt: piState.endedAt,
      files: { video: { name: 'video.mp4', bytes: 8 }, audio: { name: 'audio.wav', bytes: 8 }, accelerometer: { name: 'mpu6050.csv', bytes: csv.length } },
      sensors: { video: { ok: true }, audio: { ok: true }, accelerometer: { ok: true } },
      upload: { ok: up.ok, status: up.status },
      mock: true,
    });
  });
  const piServer = await new Promise((resolve) => { const s = fakePi.listen(0, () => resolve(s)); });
  const piUrl = `http://127.0.0.1:${piServer.address().port}`;

  // Fake "python" binary standing in for the feature pipeline ----------------
  const fakePipelineOut = {
    features: {
      step_count: 28, cadence: 110.8, gait_regularity: 0.147, activity_ratio: 0.757,
      mean_rotation: 130.2, rotation_variability: 97.7,
      mean_loudness: 0.017, vocal_activity_ratio: 0.597, loudness_variability: 0.02, loudness_trend: -0.0015,
      mean_mouth_opening: 1.21, mouth_opening_rate: 67.3, opening_variability: 2.45, opening_trend: -0.03,
      video_detection_rate: 1.0,
    },
    mouthOpening: { values: Array.from({ length: 10 }, (_, i) => [1 + i * 0.1, 50 + i]), sampleRate: 30 },
    soundPressure: { values: Array.from({ length: 20 }, (_, i) => -40 + i), sampleRate: 62.5, unit: 'dB' },
  };
  const fakePython = path.join(dataDir, 'fake-python.sh');
  fs.writeFileSync(fakePython, `#!/bin/sh\ncat "${path.join(dataDir, 'pipeline-out.json')}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dataDir, 'pipeline-out.json'), JSON.stringify(fakePipelineOut));

  // API server in Pi mode ----------------------------------------------------
  const app2 = buildApp(pool2, { piAgentUrl: piUrl, ingestToken: TOKEN, dataDir, pythonBin: fakePython });
  const server2 = await new Promise((resolve) => { const s = app2.listen(0, () => resolve(s)); });
  serverBaseUrl = `http://127.0.0.1:${server2.address().port}`;

  const call2 = async (method, path, body, expectStatus, extraHeaders) => {
    const res = await fetch(serverBaseUrl + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(extraHeaders || {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    assert.strictEqual(res.status, expectStatus, `${method} ${path} -> ${res.status}, expected ${expectStatus}`);
    if (res.status === 204) return null;
    return res.json().catch(() => null);
  };

  const agentStatus = await call2('GET', '/agent/status', undefined, 200);
  assert.strictEqual(agentStatus.mode, 'pi');
  assert.strictEqual(agentStatus.reachable, true);
  ok('GET /agent/status reports Pi reachable');

  const pexp = await call2('POST', '/experiments', { patientNumber: 'P-0100' }, 201);
  const pex = await call2('POST', `/experiments/${pexp.id}/exercises`, {}, 201);

  const pstart = await call2('POST', `/exercises/${pex.id}/recording/start`, undefined, 200);
  assert.strictEqual(pstart.recordingStatus, 'recording');
  assert.strictEqual(piState.exerciseId, pex.id, 'Pi received the exerciseId');
  ok('start delegates to Pi agent');

  const pstop = await call2('POST', `/exercises/${pex.id}/recording/stop`, undefined, 200);
  assert.strictEqual(pstop.recordingStatus, 'stopped');
  assert.strictEqual(pstop.hasData, true, 'raw upload landed during stop');
  assert.strictEqual(pstop.hasRawData, true);
  ok('stop triggers Pi upload; data stored');

  const pdata = await call2('GET', `/exercises/${pex.id}/data`, undefined, 200);
  assert.strictEqual(pdata.exerciseId, pex.id);
  assert.strictEqual(pdata.startedAt, piState.startedAt, "Pi's startedAt is authoritative");
  assert.strictEqual(pdata.footSpeed.values.length, 250, 'footSpeed sized from real CSV rows');
  ok('processed ExerciseData derived from raw upload');

  // Background pipeline: poll until the real features land in the data.
  let piped = null;
  for (let i = 0; i < 50; i++) {
    const d = await call2('GET', `/exercises/${pex.id}/data`, undefined, 200);
    if (d.features) { piped = d; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(piped, 'pipeline results were merged into ExerciseData');
  assert.strictEqual(piped.features.step_count, 28);
  assert.strictEqual(piped.mouthOpening.values.length, 10);
  assert.deepStrictEqual(piped.mouthOpening.values[0], [1, 50]);
  assert.strictEqual(piped.processedSignals.mouthOpening, true);
  assert.strictEqual(piped.processedSignals.footSpeed, false);
  assert.strictEqual(piped.aggregates.averages.soundPressure, -30.5);
  assert.strictEqual(piped.soundPressure.sampleRate, 62.5);
  assert.strictEqual(piped.pipeline.status, 'done');
  ok('feature pipeline merges real mouth/sound signals + features');

  // Reprocess on demand (for recordings made before the pipeline existed).
  await call2('POST', `/exercises/${pex.id}/data/reprocess`, undefined, 202);
  let reprocessed = null;
  for (let i = 0; i < 50; i++) {
    const d = await call2('GET', `/exercises/${pex.id}/data`, undefined, 200);
    if (d.pipeline && d.pipeline.status === 'done') { reprocessed = d; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(reprocessed && reprocessed.features, 'reprocess reran the pipeline');
  ok('POST data/reprocess reruns pipeline');

  const manifest = await call2('GET', `/exercises/${pex.id}/data/raw`, undefined, 200);
  assert.ok(manifest.files.video && manifest.files.audio && manifest.files.accelerometer);
  assert.strictEqual(manifest.metadata.mock, true);
  ok('GET raw manifest');

  const fileRes = await fetch(`${serverBaseUrl}/exercises/${pex.id}/data/raw/accelerometer`);
  assert.strictEqual(fileRes.status, 200);
  const csvBody = await fileRes.text();
  assert.ok(csvBody.startsWith('t_s,ax_g'));
  ok('download raw file');

  // Auth: upload without token is rejected.
  const badUp = await fetch(`${serverBaseUrl}/exercises/${pex.id}/data/raw`, { method: 'POST', body: new FormData() });
  assert.strictEqual(badUp.status, 401);
  ok('raw upload without bearer token -> 401');

  // Clear removes data, raw manifest and files on disk.
  await call2('DELETE', `/exercises/${pex.id}/data`, undefined, 204);
  const cleared2 = await call2('GET', `/exercises/${pex.id}`, undefined, 200);
  assert.strictEqual(cleared2.hasData, false);
  assert.strictEqual(cleared2.hasRawData, false);
  assert.ok(!fs.existsSync(path.join(dataDir, pex.id)), 'raw files removed from disk');
  ok('clear data removes raw files');

  await call2('POST', `/exercises/${pex.id}/data/reprocess`, undefined, 409);
  ok('reprocess without raw files -> 409');

  // Pi unreachable -> 502 from start.
  piServer.close();
  await call2('POST', `/exercises/${pex.id}/recording/start`, undefined, 502);
  ok('Pi unreachable -> 502');

  server2.close();
  await pool.end?.();
  await pool2.end?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`\nAll ${passed} checks passed.`);
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err.message);
  process.exit(1);
});
