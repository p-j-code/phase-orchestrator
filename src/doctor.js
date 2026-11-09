// Doctor — diagnostic command that verifies auth, account identity, and
// model-routing actually-vs-configured for the orchestrator.
//
// Usage:  npm run doctor              (full check, may spend ~$0.001 on probe call)
//         npm run doctor -- --no-probe (skip the actual Claude call)
//         npm run doctor -- --json     (machine-readable output)
//
// What it proves vs what it can only suggest is documented in each check.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const USER_CONFIG_PATH = path.join(os.homedir(), '.ashmero-orchestrator', 'user.json');
const STATE_DB_PATH = path.join(REPO_ROOT, 'state', 'orchestrator.db');
const LOGS_DIR = path.join(REPO_ROOT, 'logs');

// ─── Check helpers ──────────────────────────────────────────────────────────

class Doctor {
  constructor() {
    this.checks = [];
    this.warnings = [];
    this.failures = [];
  }

  pass(name, evidence) {
    this.checks.push({ name, status: 'pass', evidence });
    console.log(chalk.green(`  ✓ ${name}`));
    if (evidence) console.log(chalk.dim(`      ${evidence}`));
  }

  warn(name, message, hint) {
    this.warnings.push({ name, message, hint });
    this.checks.push({ name, status: 'warn', message });
    console.log(chalk.yellow(`  ⚠ ${name}`));
    console.log(chalk.yellow(`      ${message}`));
    if (hint) console.log(chalk.dim(`      → ${hint}`));
  }

  fail(name, message, hint) {
    this.failures.push({ name, message, hint });
    this.checks.push({ name, status: 'fail', message });
    console.log(chalk.red(`  ✗ ${name}`));
    console.log(chalk.red(`      ${message}`));
    if (hint) console.log(chalk.dim(`      → ${hint}`));
  }

  info(message) {
    console.log(chalk.dim(`  ${message}`));
  }

  section(title) {
    console.log('');
    console.log(chalk.bold.cyan(title));
  }
}

// ─── Individual checks ──────────────────────────────────────────────────────

async function checkApiKeyEnv(doc) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    doc.pass('ANTHROPIC_API_KEY env var is NOT set in your shell',
      'Means orchestrator subprocesses cannot accidentally use API billing');
    return true;
  }
  doc.warn('ANTHROPIC_API_KEY is set in your shell',
    `Value detected (length ${key.length}). The orchestrator unsets this in subprocesses, but having it set globally is a risk.`,
    'Remove from ~/.zshrc or ~/.bash_profile, then: source ~/.zshrc');
  return true; // not a failure since orchestrator handles it
}

async function checkClaudeBin(doc) {
  const userCfg = await readUserConfig();
  const claudeBin = userCfg?.claude_bin;
  if (!claudeBin) {
    doc.fail('claude_bin not configured in user.json',
      'Cannot verify Claude Code version or auth status without knowing the binary location.',
      'Run: npm run init  OR edit ~/.ashmero-orchestrator/user.json');
    return null;
  }

  if (!fsSync.existsSync(claudeBin)) {
    doc.fail(`claude_bin path does not exist: ${claudeBin}`,
      'The configured binary is missing.',
      'Reinstall Claude Code: npm install -g @anthropic-ai/claude-code');
    return null;
  }

  // Get version
  const version = await runQuick(claudeBin, ['--version']);
  if (version.code !== 0) {
    doc.warn('claude --version failed', `Exit ${version.code}`, 'May still work for -p calls');
    return claudeBin;
  }
  doc.pass(`Claude Code binary OK`, `${claudeBin} → ${version.stdout.trim()}`);
  return claudeBin;
}

async function checkUserConfig(doc) {
  const userCfg = await readUserConfig();
  if (!userCfg) {
    doc.fail('user.json missing',
      `Expected at ${USER_CONFIG_PATH}`,
      'Run: npm run init');
    return null;
  }

  const acct = userCfg.claude_account || {};
  if (!acct.email) {
    doc.warn('Account email not configured in user.json',
      'The orchestrator can run, but the auto-runner header will say "not configured".',
      `Run: npm run account -- --email <your@email.com>`);
  } else {
    doc.pass(`Account email configured: ${acct.email}`,
      `Plan: ${acct.plan || '(not set)'}`);
  }

  return userCfg;
}

async function probeClaudeAuth(doc, claudeBin) {
  doc.info('Running probe call: `claude -p "echo ok"` to verify auth and capture metadata...');

  const result = await runQuick(claudeBin, [
    '-p', 'Respond with exactly the word: ok',
    '--output-format', 'json',
    '--model', 'claude-haiku-4-5-20251001',
    '--max-turns', '1',
  ], { timeoutMs: 30000, unsetApiKey: true });

  if (result.code !== 0) {
    doc.fail('Probe call failed',
      `Exit code ${result.code}. Stderr: ${result.stderr.slice(0, 200)}`,
      'If auth-related: open `claude`, type /status, then /logout + /login');
    return null;
  }

  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch {
    doc.warn('Probe response not JSON',
      `First 200 chars: ${result.stdout.slice(0, 200)}`,
      'Claude Code may have changed output format. Manually check: open `claude` then /status');
    return null;
  }

  // The actual model used (sometimes differs slightly from the one requested)
  const modelUsage = parsed.modelUsage || {};
  const modelsUsed = Object.keys(modelUsage);
  if (modelsUsed.length === 0) {
    doc.warn('Probe call returned no modelUsage data', 'Cannot verify which model handled the request', null);
  } else {
    doc.pass('Probe call completed',
      `Models in response: ${modelsUsed.join(', ')}, total cost (display): $${(parsed.total_cost_usd || 0).toFixed(6)}`);
  }

  // apiKeySource — the most important field
  // Claude Code includes this in JSON output to indicate auth method
  const apiKeySource = parsed.apiKeySource || parsed.api_key_source || parsed.auth?.source;
  if (apiKeySource) {
    if (/subscription|max|claude_code|oauth/i.test(apiKeySource)) {
      doc.pass(`Auth source: SUBSCRIPTION (${apiKeySource})`,
        'You are using Max plan. Will NOT be billed to API credits.');
    } else if (/api|key/i.test(apiKeySource)) {
      doc.fail(`Auth source: API KEY (${apiKeySource})`,
        'You are using pay-as-you-go API billing, NOT Max plan!',
        'Run: claude logout → claude (re-login with claude.ai account that has Max)');
    } else {
      doc.warn(`Auth source unclear: ${apiKeySource}`,
        'Could not categorize the auth source string',
        'Verify by opening `claude` and typing /status');
    }
  } else {
    doc.warn('apiKeySource field not in response',
      'Claude Code did not include auth source in the JSON. May depend on version.',
      'Verify by opening `claude` and typing /status (look for "Login method: Claude Max account")');
  }

  return parsed;
}

async function checkRecentCalls(doc) {
  const sqlite3Path = await findSqlite3();
  if (!sqlite3Path) {
    doc.warn('sqlite3 CLI not found',
      'Cannot directly query SQLite from doctor. Open state/orchestrator.db with a tool to verify recent calls.',
      'macOS: `brew install sqlite3` (usually preinstalled), then: sqlite3 state/orchestrator.db');
    return;
  }

  if (!fsSync.existsSync(STATE_DB_PATH)) {
    doc.info('No SQLite DB yet — no calls have been made. Skipping call history check.');
    return;
  }

  const result = await runQuick(sqlite3Path, [
    STATE_DB_PATH,
    `-header`,
    `-column`,
    `SELECT task, model, cost_usd, project, datetime(started_at,'localtime') AS time FROM calls ORDER BY started_at DESC LIMIT 10;`,
  ], { timeoutMs: 5000 });

  if (result.code !== 0) {
    doc.warn('Could not query SQLite', result.stderr.slice(0, 200), null);
    return;
  }

  if (!result.stdout.trim()) {
    doc.info('No calls in history yet');
    return;
  }

  console.log(chalk.dim('\n  Recent 10 calls:'));
  for (const line of result.stdout.trim().split('\n')) {
    console.log(chalk.dim(`    ${line}`));
  }

  // Parse models actually used
  const lines = result.stdout.trim().split('\n').slice(2); // skip header rows
  const modelCounts = {};
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const model = parts[1];
    if (model) modelCounts[model] = (modelCounts[model] || 0) + 1;
  }
  const modelsList = Object.entries(modelCounts).map(([m, c]) => `${m}: ${c}`).join(', ');
  if (modelsList) {
    doc.pass(`Model distribution in last 10 calls`, modelsList);
  }
}

async function checkLogsForModelUsage(doc) {
  if (!fsSync.existsSync(LOGS_DIR)) {
    doc.info('No logs directory yet');
    return;
  }

  // Find most recent dev-execution log
  let entries;
  try { entries = await fs.readdir(LOGS_DIR); }
  catch { return; }

  const devLogs = entries
    .filter((f) => f.includes('dev-execution') && f.endsWith('.stdout.log'))
    .sort()
    .reverse()
    .slice(0, 3);

  if (devLogs.length === 0) {
    doc.info('No dev-execution logs found yet (no phases have run)');
    return;
  }

  doc.info(`Checking modelUsage in last ${devLogs.length} dev-execution log(s)...`);

  for (const log of devLogs) {
    const content = await fs.readFile(path.join(LOGS_DIR, log), 'utf-8');
    // Extract modelUsage JSON block
    const m = content.match(/"modelUsage"\s*:\s*\{([^}]+)\}/s);
    if (!m) {
      doc.info(`  ${log}: no modelUsage field`);
      continue;
    }
    // Parse model names from the modelUsage block
    const modelMatches = [...m[1].matchAll(/"(claude-[a-z0-9.-]+)"/g)];
    const models = [...new Set(modelMatches.map((mm) => mm[1]))];
    doc.info(`  ${log}: ${models.join(', ')}`);
  }
}

const EXPECTED_TABLES = [
  // state.js migrate() — auto-applied on first DB open
  'projects', 'phases', 'sessions', 'calls', 'auto_runs', 'bug_rounds',
  // migrate-bot.js (v0.5)
  'tg_users', 'tg_jobs', 'tg_auth_codes', 'tg_pinned_projects',
  // migrate-requirements.js (v0.7)
  'requirements', 'tg_capture_modes',
  // migrate-validators.js (v0.9)
  'validator_runs',
  // migrate-bug-inbox.js (v0.12)
  'bug_inbox',
];

async function checkExpectedTables(doc) {
  if (!fsSync.existsSync(STATE_DB_PATH)) {
    doc.info('No SQLite DB yet — skipping table check.');
    return;
  }
  let db;
  try {
    db = new Database(STATE_DB_PATH, { readonly: true });
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const actualTables = new Set(rows.map((r) => r.name));
    const missing = EXPECTED_TABLES.filter((t) => !actualTables.has(t));
    if (missing.length === 0) {
      doc.pass('All required SQLite tables present', EXPECTED_TABLES.join(', '));
    } else {
      doc.fail('Missing SQLite tables', missing.join(', '), 'Run: npm run migrate-all');
    }
    // Schema fingerprint: migrate() stamps PRAGMA user_version. A mismatch
    // means this DB's last schema pass ran under different code than what is
    // deployed here (the classic Mac↔NAS drift, previously invisible).
    const { STATE_SCHEMA_VERSION } = await import('./state.js');
    const stamped = Number(db.pragma('user_version', { simple: true })) || 0;
    if (stamped === STATE_SCHEMA_VERSION) {
      doc.pass('Schema fingerprint matches', `user_version=${stamped}`);
    } else if (stamped === 0) {
      doc.warn(`Schema fingerprint absent (user_version=0, code expects ${STATE_SCHEMA_VERSION}) — DB predates the stamp; any getDb() touch will stamp it`);
    } else {
      doc.warn(`Schema fingerprint mismatch: DB=${stamped}, code=${STATE_SCHEMA_VERSION} — the DB was last migrated by different code (Mac/NAS drift?)`);
    }
  } finally {
    if (db) db.close();
  }
}

async function checkConfigConsistency(doc) {
  const defaults = JSON.parse(fsSync.readFileSync(path.join(REPO_ROOT, 'config', 'defaults.json'), 'utf-8'));
  const routing = JSON.parse(fsSync.readFileSync(path.join(REPO_ROOT, 'config', 'model-routing.json'), 'utf-8'));

  // Check that tier_models referenced in routing exist in tier_models map
  const tierModels = defaults.model_routing?.tier_models || {};
  const referenced = new Set();
  for (const r of routing.keyword_rules || []) {
    for (const k of ['force_tier', 'min_tier', 'max_tier']) {
      if (r[k]) referenced.add(r[k]);
    }
  }
  // v0.17: hard_floors entries may be a plain tier string (legacy, unconditional)
  // or a { tier, when } object (size-gated conditional floor — see
  // model-router.js's resolveHardFloor). Either shape names one tier to validate.
  for (const floor of Object.values(routing.hard_floors || {})) {
    const t = typeof floor === 'string' ? floor : (floor && typeof floor === 'object' ? floor.tier : undefined);
    if (t) referenced.add(t);
  }

  const missing = [...referenced].filter((t) => !tierModels[t]);
  if (missing.length > 0) {
    doc.warn(`Routing rules reference tiers without models: ${missing.join(', ')}`,
      'These tiers will fall back to literal names instead of model IDs',
      'Add to config/defaults.json model_routing.tier_models');
  } else {
    doc.pass('All tier names in routing rules have model mappings');
  }

  // Check that all task types in defaults.models exist
  const tasks = Object.keys(defaults.models || {});
  doc.pass(`Configured tasks: ${tasks.length}`,
    tasks.join(', '));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function readUserConfig() {
  try { return JSON.parse(await fs.readFile(USER_CONFIG_PATH, 'utf-8')); }
  catch { return null; }
}

function runQuick(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (opts.unsetApiKey) delete env.ANTHROPIC_API_KEY;
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ code: -1, stdout, stderr: stderr + '\n[doctor: timeout]' });
    }, opts.timeoutMs || 10000);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      resolve({ code: code || 0, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message });
    });
  });
}

async function findSqlite3() {
  for (const p of ['/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3', '/usr/local/bin/sqlite3']) {
    if (fsSync.existsSync(p)) return p;
  }
  return null;
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function runDoctor(opts = {}) {
  const doc = new Doctor();
  console.log(chalk.bold.cyan('═══ Orchestrator Doctor ═══\n'));
  console.log(chalk.dim('Verifying auth, account, and model selection are working correctly.\n'));

  doc.section('1. Environment');
  await checkApiKeyEnv(doc);

  doc.section('2. Claude Code binary');
  const claudeBin = await checkClaudeBin(doc);

  doc.section('3. User config');
  const userCfg = await checkUserConfig(doc);

  doc.section('4. Configuration consistency');
  await checkConfigConsistency(doc);

  doc.section('4a. SQLite table presence');
  await checkExpectedTables(doc);

  if (!opts.noProbe && claudeBin) {
    doc.section('5. Live auth probe (sends 1 tiny Claude call)');
    await probeClaudeAuth(doc, claudeBin);
  } else if (opts.noProbe) {
    doc.section('5. Live auth probe — SKIPPED (--no-probe)');
  }

  doc.section('6. Recent call history (SQLite)');
  await checkRecentCalls(doc);

  doc.section('7. Recent log files (modelUsage)');
  await checkLogsForModelUsage(doc);

  // Summary
  console.log('');
  console.log(chalk.bold.cyan('═══ Summary ═══\n'));
  const passes = doc.checks.filter((c) => c.status === 'pass').length;
  console.log(`  ${chalk.green('✓')} Passes:   ${passes}`);
  console.log(`  ${chalk.yellow('⚠')} Warnings: ${doc.warnings.length}`);
  console.log(`  ${chalk.red('✗')} Failures: ${doc.failures.length}`);

  if (doc.failures.length === 0 && doc.warnings.length === 0) {
    console.log(chalk.green('\n  All checks passed. Orchestrator is correctly configured.'));
  } else if (doc.failures.length === 0) {
    console.log(chalk.yellow('\n  No failures, but review warnings above.'));
  } else {
    console.log(chalk.red('\n  Failures detected. Address above before running production work.'));
  }

  console.log(chalk.bold.cyan('\n═══ What this proves and doesn\'t ═══'));
  console.log(chalk.dim(`
  PROVES:
    • Auth source field from Claude Code's own response (subscription vs api)
    • Which models were actually used in recent calls (from logs/ + SQLite)
    • Configuration is internally consistent

  DOES NOT PROVE (you must check separately):
    • That the email in user.json matches the email actually logged into claude.ai
      (orchestrator can't introspect the OAuth token's account claim)
    • Future calls — only what already ran
    • Whether your Max plan is active on Anthropic's side
      (check at https://claude.ai/settings/billing)

  The most authoritative check is opening interactive \`claude\` and typing \`/status\`.
  That shows exactly which account, model, and login method are active.
`));

  if (opts.json) {
    return { passes, warnings: doc.warnings.length, failures: doc.failures.length, checks: doc.checks };
  }

  return { passes, warnings: doc.warnings.length, failures: doc.failures.length };
}

// Allow running directly: node src/doctor.js
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const noProbe = process.argv.includes('--no-probe');
  const json = process.argv.includes('--json');
  runDoctor({ noProbe, json }).then((r) => {
    if (json) console.log(JSON.stringify(r, null, 2));
    process.exit(r.failures > 0 ? 1 : 0);
  });
}
