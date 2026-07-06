'use strict';

const { buildApp } = require('./src/app');
const db = require('./src/db');

const PORT = process.env.PORT || 3000;

async function main() {
  const pool = db.createPool();
  await db.initSchema(pool);

  const app = buildApp(pool);
  app.listen(PORT, () => {
    console.log(`Experiment API running on http://localhost:${PORT}`);
    console.log(`  Admin UI: http://localhost:${PORT}/admin`);
    console.log(`  Docs:     http://localhost:${PORT}/docs`);
    console.log(`  Spec:     http://localhost:${PORT}/openapi.yaml`);
    console.log(
      process.env.PI_AGENT_URL
        ? `  Recording: Raspberry Pi agent at ${process.env.PI_AGENT_URL}`
        : '  Recording: STUB mode (set PI_AGENT_URL to use the Pi agent)'
    );
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
