# Experiment API + Admin UI

REST API for managing experiments and exercises in a research study investigating
the relationship between language and movement in Parkinson's patients — implemented
per the [reference spec](https://github.com/davidlinner/experiment-api), backed by
**PostgreSQL**, with a built-in **admin UI**.

## Features

- Full implementation of the OpenAPI 3.0 spec (`openapi.yaml`): experiments CRUD,
  exercises, recording start/stop, exercise data retrieval and clearing.
- PostgreSQL persistence (`pg`), schema auto-created on startup, cascade deletes.
- Admin UI at `/admin`: manage experiments and exercises, control recording,
  and view recorded data as charts (mouth opening, sound pressure, foot speed,
  step lengths) plus aggregate statistics.
- Scalar API docs with "Try it" console at `/docs`.
- Recorded sensor data is **stub-generated** on recording stop (random plausible
  values) — swap `src/stub-data.js` for real sensor integration later.

## Quick start (local)

Requires Node 18+ and a PostgreSQL database.

```bash
npm install
DATABASE_URL=postgresql://user:password@localhost:5432/experiments npm start
```

Then open:

- **Admin UI:** http://localhost:3000/admin (also `/`)
- **API docs:** http://localhost:3000/docs
- **OpenAPI spec:** http://localhost:3000/openapi.yaml

Environment variables:

| Variable       | Description                                                        |
| -------------- | ------------------------------------------------------------------ |
| `DATABASE_URL` | PostgreSQL connection string (**required**)                        |
| `PORT`         | HTTP port (default `3000`)                                         |
| `PGSSL`        | Set to `require` to enable SSL (needed for public DB endpoints)    |

## Deploy on Railway

1. Create a new Railway project and add a **PostgreSQL** database service.
2. Add a service from this repository (push it to GitHub first, or use `railway up`).
3. In the app service → **Variables**, add:
   `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (reference to the DB service).
   Railway injects `PORT` automatically; no other config needed.
4. Deploy. Railway runs `npm install` and `npm start` by default.
5. Open the generated domain — `/admin` for the UI, `/docs` for the API docs.

Note: when using Railway's **internal** database URL (`postgres.railway.internal`)
no SSL is needed. If you connect via the **public** proxy URL instead, set
`PGSSL=require`.

## Tests

```bash
npm test
```

Runs an end-to-end smoke test (25 checks over every route) against an in-memory
PostgreSQL emulator (`pg-mem`) — no database needed.

## Project layout

```
openapi.yaml       OpenAPI 3.0 specification (source of truth for the API)
server.js          Entry point: connects to Postgres, initializes schema, starts app
src/app.js         Express app: all routes, validation, docs, admin UI serving
src/db.js          PostgreSQL access layer (pool, schema, queries)
src/stub-data.js   Stub sensor-data generator (replace with real integration)
public/admin.html  Single-file admin UI (vanilla JS + Chart.js)
test/smoke.js      End-to-end smoke test using pg-mem
```

## Data model

Two tables. `exercises.data` holds the recorded payload as JSONB; `hasData` in the
API is derived from it. Deleting an experiment cascades to its exercises.

```
experiments (id, patient_number, height, age, weight, properties JSONB, created_at)
exercises   (id, experiment_id → experiments ON DELETE CASCADE, properties JSONB,
             recording_status, recording_started_at, recording_ended_at,
             data JSONB, created_at)
```
