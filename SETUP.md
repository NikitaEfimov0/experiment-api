# Setup Guide — Run Locally & Deploy to Railway

## 1. Run locally

### Prerequisites

- Node.js 18 or newer (`node --version`)
- A PostgreSQL database. Pick one option:

**Option A — Docker (easiest):**

```bash
docker run -d --name experiments-db \
  -e POSTGRES_PASSWORD=secret \
  -e POSTGRES_DB=experiments \
  -p 5432:5432 postgres:16
```

Your connection string is then:
`postgresql://postgres:secret@localhost:5432/experiments`

**Option B — Locally installed PostgreSQL:**

```bash
createdb experiments
```

Connection string: `postgresql://<your-user>@localhost:5432/experiments`

**Option C — No local DB at all:** create the Postgres service on Railway first
(see section 2), copy its **public** connection URL from the Postgres service →
Variables → `DATABASE_PUBLIC_URL`, and use that locally with `PGSSL=require`.

### Start the server

```bash
npm install
DATABASE_URL=postgresql://postgres:secret@localhost:5432/experiments npm start
```

On Windows (PowerShell):

```powershell
$env:DATABASE_URL="postgresql://postgres:secret@localhost:5432/experiments"; npm start
```

The database schema is created automatically on first start. Then open:

- Admin UI: http://localhost:3000/admin
- API docs (with "Try it" console): http://localhost:3000/docs
- OpenAPI spec: http://localhost:3000/openapi.yaml

Use a different port with `PORT=8080 npm start`.

### Run the tests (no database needed)

```bash
npm test
```

## 2. Deploy to Railway

### Option A — Deploy from GitHub (recommended)

1. **Push the project to GitHub.** In the project folder:

   ```bash
   git init
   git add .
   git commit -m "Experiment API"
   git remote add origin https://github.com/<your-username>/experiment-api.git
   git push -u origin main
   ```

   (`node_modules` is already excluded by `.gitignore`.)

2. **Create the Railway project.** Log in at https://railway.com → **New Project**
   → **Deploy from GitHub repo** → authorize Railway and pick your repo.
   Railway auto-detects Node.js and runs `npm install` + `npm start`.
   The first deploy will crash — that's expected, `DATABASE_URL` isn't set yet.

3. **Add PostgreSQL.** In the project canvas: **New** (or right-click) →
   **Database** → **Add PostgreSQL**. Wait until it's deployed.

4. **Connect the app to the database.** Open your app service → **Variables** →
   **New Variable** → click **Add Reference** and select `DATABASE_URL` from the
   Postgres service (or type it manually):

   ```
   DATABASE_URL = ${{Postgres.DATABASE_URL}}
   ```

   Railway injects `PORT` automatically — do not set it. `PGSSL` is not needed:
   the internal `railway.internal` connection doesn't use SSL.

5. **Redeploy** the app service (Deployments → ⋮ → Redeploy) if it doesn't
   restart on its own.

6. **Expose it to the internet.** App service → **Settings** → **Networking** →
   **Generate Domain**. Open the URL:
   - `https://<your-app>.up.railway.app/admin` — admin UI
   - `https://<your-app>.up.railway.app/docs` — API docs

7. From now on, every `git push` to `main` triggers an automatic redeploy.

### Option B — Deploy with the Railway CLI (no GitHub needed)

```bash
npm install -g @railway/cli
railway login
railway init          # create a new project
railway add           # choose PostgreSQL
railway link          # link the folder to your app service if prompted
railway variables --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}'
railway up            # uploads and deploys the current folder
railway domain        # generate a public URL
```

### Troubleshooting

- **App crashes with "DATABASE_URL is not set"** — step 4 was skipped, or the
  variable is on the wrong service. It must be on the *app* service.
- **`ECONNREFUSED` / SSL errors** — if you used the *public* database URL
  (`...proxy.rlwy.net...`) instead of the reference variable, set `PGSSL=require`.
  Prefer the reference variable: it uses Railway's private network (faster, free
  egress).
- **Tables missing** — the schema is created automatically at startup; check the
  deploy logs for the "Experiment API running" message.
