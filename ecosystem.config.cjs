// PM2 production topology for an always-on (headless) deployment.
// The UI and durable queue worker are separate failure domains: restarting the
// dashboard cannot interrupt queue ownership, and restarting the worker causes
// SQLite lease reconciliation to resume in-flight work automatically.

const path = require('node:path');

const cwd = __dirname;
const shared = {
  cwd,
  autorestart: true,
  restart_delay: 5000,
  kill_timeout: 30000,
  max_memory_restart: '4G',
  time: true,
  // Execution-host identity is deliberately NOT set here. This file is checked
  // in and rsynced to every host, so hardcoding ASHMERO_ROLE=nas would make any
  // host that runs `pm2 start ecosystem.config.cjs` a second executor against
  // the shared provider account — defeating the single-writer policy. Identity
  // is host-local instead: set ASHMERO_ROLE/ASHMERO_HOST_ID in that
  // host's .env (loaded at startup by src/lib/env-file.js). A host without
  // those keys resolves to role 'mac' and correctly fails closed.
  env: { NODE_ENV: 'production' },
};

module.exports = {
  apps: [
    {
      ...shared,
      name: 'ashmero-web',
      script: path.join(cwd, 'src', 'orchestrator.js'),
      args: 'web --host 0.0.0.0',
    },
    {
      ...shared,
      name: 'ashmero-worker',
      script: path.join(cwd, 'src', 'worker.js'),
    },
  ],
};
