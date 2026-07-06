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
  await pool.end?.();
  console.log(`\nAll ${passed} checks passed.`);
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err.message);
  process.exit(1);
});
