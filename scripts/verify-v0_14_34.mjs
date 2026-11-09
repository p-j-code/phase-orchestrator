// v0.14.34 verifier — proves the four cost-cut changes landed and behave:
//
//   A. /spend report          — wiring + dependency-free render (9 checks)
//   B. clean-audit signal     — deterministic "(nothing to promote)" detection (5)
//   C. incremental re-audits  — prompt branching + SHA stamp + git helper (11)
//   D. two-strike stall       — escalation source assertions (4)
//   E. template + version     — promote gate in template, 0.14.34 stamp (2... merged into A/B counts where natural)
//
// 32 checks total. Functional where the code path is reachable without a
// claude subprocess; source assertions for the in-loop runner logic.
//
// NOTE: group C imports phase-runner.js, which transitively loads
// better-sqlite3 — run this on the live install (it builds there), not in a
// sandbox without native modules.
//
// Run with: node scripts/verify-v0_14_34.mjs
// Exits 0 on full pass, 1 on any failure.

import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import chalk from 'chalk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

let passed = 0;
let failed = 0;
function check(label, ok, details) {
  if (ok) { console.log(chalk.green('  OK  '), label); passed += 1; }
  else    { console.log(chalk.red('  FAIL'), label, details ? chalk.dim(`— ${details}`) : ''); failed += 1; }
}

function readSrc(rel) {
  const p = resolve(REPO_ROOT, rel);
  if (!existsSync(p)) throw new Error(`Missing file: ${rel}`);
  return readFileSync(p, 'utf8');
}

console.log(chalk.bold('\n── v0.14.34 verifier ──\n'));

// ─── A. /spend report ────────────────────────────────────────────────────────
console.log(chalk.bold('A. /spend report'));

const costMod = await import(resolve(REPO_ROOT, 'src/lib/cost-report.js'));
check('cost-report.js exports costReport / renderCostReport / shortModel',
  typeof costMod.costReport === 'function'
  && typeof costMod.renderCostReport === 'function'
  && typeof costMod.shortModel === 'function');

check('costReport is async (lazy DB import — render helpers stay dependency-free)',
  costMod.costReport.constructor.name === 'AsyncFunction');

const fakeReport = {
  days: 30, project: null,
  rows: [
    { task: 'audit', model: 'claude-opus-4-8', n: 12, errors: 1, usd: 42.5, input_tokens: 9_400_000, output_tokens: 310_000, cache_read_tokens: 2_100_000 },
    { task: 'dev-execution', model: 'claude-sonnet-4-6', n: 90, errors: 0, usd: 18.2, input_tokens: 14_000_000, output_tokens: 2_500_000, cache_read_tokens: 9_000_000 },
  ],
  byProject: [{ project: 'reelchain', n: 60, usd: 30.1 }, { project: 'aorch', n: 42, usd: 30.6 }],
  totals: { n: 102, usd: 60.7, errors: 1, uncosted: 3 },
};
const rendered = costMod.renderCostReport(fakeReport);
check('renderCostReport: totals line + uncosted note + task×model rows',
  /Total: \$60\.70 across 102 call\(s\), 1 error\(s\)/.test(rendered)
  && /3 call\(s\) had no cost data/.test(rendered)
  && /audit · opus-4-8/.test(rendered)
  && /9\.4M/.test(rendered), rendered.split('\n')[1]);

check('renderCostReport: per-project breakdown when unscoped',
  /By project:/.test(rendered) && /reelchain \(60×\)/.test(rendered));

check('renderCostReport caps rows (maxRows) and rolls up the remainder',
  /…1 more row\(s\)/.test(costMod.renderCostReport(fakeReport, { maxRows: 1 })));

check('shortModel strips claude- prefix',
  costMod.shortModel('claude-opus-4-8') === 'opus-4-8' && costMod.shortModel(null) === '?');

const parity = readSrc('src/server/telegram-parity-handlers.js');
check('telegram-parity-handlers.js exports handleSpend and awaits costReport',
  /export const handleSpend = requireAuth/.test(parity)
  && /await costReport\(\{ days, project \}\)/.test(parity));

const serverSrc = readSrc('src/server.js');
check('server.js imports handleSpend and registers /spend|/spent|/costs',
  /handleSpend/.test(serverSrc)
  && /bot\.command\(\['spend', 'spent', 'costs'\], handleSpend\)/.test(serverSrc));

const { COMMAND_MENU } = await import(resolve(REPO_ROOT, 'src/lib/command-menu.js'))
  .then((m) => ({ COMMAND_MENU: m.COMMAND_MENU || m.default || Object.values(m).find(Array.isArray) }));
check('command menu still ≤ 25 entries (mobile cap; /spend is menu-excluded like /budget)',
  Array.isArray(COMMAND_MENU) && COMMAND_MENU.length <= 25,
  `entries: ${COMMAND_MENU?.length}`);

// ─── B. clean-audit signal ───────────────────────────────────────────────────
console.log(chalk.bold('\nB. clean-audit signal'));

const { extractPromoteSection } = await import(resolve(REPO_ROOT, 'src/lib/audit-promote.js'));
const sandbox = mkdtempSync(join(tmpdir(), 'v0_14_34-'));

const cleanAudit = join(sandbox, 'clean.md');
writeFileSync(cleanAudit, '# Audit\n\n## Critical\n\nNone.\n\n## Promote to bugs-round-3\n\n(nothing to promote — no CRITICAL or MAJOR findings)\n');
const rClean = await extractPromoteSection(cleanAudit);
check('clean marker line → { found: false, clean: true } (no junk round possible)',
  rClean.found === false && rClean.clean === true, JSON.stringify(rClean));

const dirtyAudit = join(sandbox, 'dirty.md');
writeFileSync(dirtyAudit, '# Audit\n\n## Promote to bugs-round-3\n\n### Bug #1 — FK violation on _inbox\n\n**Steps to reproduce:** x\n**Expected:** y\n**Actual:** z\n');
const rDirty = await extractPromoteSection(dirtyAudit);
check('real Bug entries still promote', rDirty.found === true && /Bug #1/.test(rDirty.content || ''));

const mixedAudit = join(sandbox, 'mixed.md');
writeFileSync(mixedAudit, '# Audit\n\n## Promote to bugs-round-3\n\n(nothing to promote — wait, actually)\n\n### Bug #1 — real bug\n\n**Steps to reproduce:** x\n');
const rMixed = await extractPromoteSection(mixedAudit);
check('marker line + real Bug entry is NOT misclassified clean', rMixed.found === true);

const variantAudit = join(sandbox, 'variant.md');
writeFileSync(variantAudit, '## Promote to bugs-round-1\n\nNothing to promote.\n');
const rVar = await extractPromoteSection(variantAudit);
check('"Nothing to promote." phrasing variant also detected clean',
  rVar.found === false && rVar.clean === true);

check('audit-promote.js carries NOTHING_TO_PROMOTE_RE',
  /NOTHING_TO_PROMOTE_RE/.test(readSrc('src/lib/audit-promote.js')));

// ─── C. incremental re-audits ────────────────────────────────────────────────
console.log(chalk.bold('\nC. incremental re-audits'));

const gitMod = await import(resolve(REPO_ROOT, 'src/lib/git.js'));
check('git.js exports changedFilesSince', typeof gitMod.changedFilesSince === 'function');
check('changedFilesSince rejects a garbage sha (→ full audit, not a crash)',
  (await gitMod.changedFilesSince(sandbox, 'not-a-sha')).ok === false);

const { buildGuidePrompt } = await import(resolve(REPO_ROOT, 'src/lib/phase-runner.js'));

// Temp project with prior audit + marker + git workspace
const projDir = mkdtempSync(join(tmpdir(), 'v0_14_34-proj-'));
const ws = join(projDir, 'workspace');
mkdirSync(join(projDir, '.guide', 'audits'), { recursive: true });
mkdirSync(ws, { recursive: true });
execSync('git init -q && git config user.email v@v && git config user.name v', { cwd: ws });
writeFileSync(join(ws, 'a.js'), 'x');
execSync('git add -A && git commit -qm one', { cwd: ws });
const sha1 = execSync('git rev-parse HEAD', { cwd: ws }).toString().trim();
writeFileSync(join(ws, 'b.js'), 'y');
writeFileSync(join(ws, 'a.js'), 'x2');
execSync('git add -A && git commit -qm two', { cwd: ws });

writeFileSync(join(projDir, '.guide', 'audits', 'audit-20260601-000000.md'), '# prior audit');
const markerPath = join(projDir, '.guide', 'audits', '.last-audit.json');
writeFileSync(markerPath, JSON.stringify({ sha: sha1, at: 'test' }));

const fakeProject = { current_phase: 0, tech_stack: 'node' };
const pIncr = await buildGuidePrompt({ task: 'audit', projectName: 'vtest', projDir, project: fakeProject, plan: null });

check('marker + prior audit + repo → INCREMENTAL prompt', /INCREMENTAL re-audit/.test(pIncr));
check('incremental prompt lists exactly the changed files',
  /workspace\/a\.js/.test(pIncr) && /workspace\/b\.js/.test(pIncr));
check('incremental prompt references the prior audit file for verification',
  /audit-20260601-000000\.md/.test(pIncr) && /verify against the current code/i.test(pIncr));
check('incremental prompt carries the severity-gated promote rules + clean-line instruction',
  /ONLY CRITICAL and MAJOR/.test(pIncr) && /nothing to promote — no CRITICAL or MAJOR findings/.test(pIncr)
  && /audit-backlog\.md/.test(pIncr));
check('still-open prior findings re-promote at original severity',
  /STILL OPEN or only PARTIALLY FIXED keeps its original severity/.test(pIncr));

rmSync(markerPath);
const pFull = await buildGuidePrompt({ task: 'audit', projectName: 'vtest', projDir, project: fakeProject, plan: null });
check('marker deleted → full audit prompt (manual full-scope escape hatch)',
  /comprehensive code audit/.test(pFull) && /every file under backend\/ and frontend\//.test(pFull));
check('full prompt also carries the promote gate + clean-line instruction',
  /ONLY CRITICAL and MAJOR/.test(pFull) && /nothing to promote — no CRITICAL or MAJOR findings/.test(pFull));

writeFileSync(markerPath, JSON.stringify({ sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', at: 'test' }));
const pDead = await buildGuidePrompt({ task: 'audit', projectName: 'vtest', projDir, project: fakeProject, plan: null });
check('dead/garbage-collected sha → falls back to full audit', /comprehensive code audit/.test(pDead));

const headSha = execSync('git rev-parse HEAD', { cwd: ws }).toString().trim();
writeFileSync(markerPath, JSON.stringify({ sha: headSha, at: 'test' }));
const pSame = await buildGuidePrompt({ task: 'audit', projectName: 'vtest', projDir, project: fakeProject, plan: null });
check('zero changed files → verification-only incremental pass',
  /INCREMENTAL re-audit/.test(pSame) && /verification-only pass/.test(pSame));

const prSrc = readSrc('src/lib/phase-runner.js');
check('runGuide stamps .last-audit.json with workspace HEAD after successful audits',
  /task === 'audit' && !result\.is_error/.test(prSrc) && /\.last-audit\.json/.test(prSrc)
  && /getHeadSha\(ws\)/.test(prSrc));

// ─── D. two-strike stall escalation ──────────────────────────────────────────
console.log(chalk.bold('\nD. two-strike stall escalation'));

const crSrc = readSrc('src/claude-runner.js');
check('stallCount counter declared', /let stallCount = 0;/.test(crSrc));
check('stall #1 retries SAME model with fresh session (drops --resume)',
  /stallCount \+= 1;/.test(crSrc)
  && /stallCount === 1/.test(crSrc)
  && /stall #1 on \$\{model\} — retrying same model/.test(crSrc));
check('Opus escalation only on stall #2+ (inside the else branch)',
  /stall #\$\{stallCount\} — escalating to/.test(crSrc)
  && !/isStall\) \{\s*const opusModel/.test(crSrc));
check('non-stall transient resets the consecutive streak',
  /stallCount = 0; \/\/ non-stall transient breaks the consecutive streak/.test(crSrc));

// ─── E. template + version ───────────────────────────────────────────────────
console.log(chalk.bold('\nE. template + version'));

const tpl = readSrc('prompts/templates/audit-template.md');
check('audit-template.md promote section is severity-gated with the clean line',
  /CRITICAL and MAJOR findings ONLY/.test(tpl)
  && /nothing to promote — no CRITICAL or MAJOR findings/.test(tpl)
  && /audit-backlog\.md/.test(tpl));

const pkg = JSON.parse(readSrc('package.json'));
check('package.json version is 0.14.34', pkg.version === '0.14.34', pkg.version);

// ─── summary ─────────────────────────────────────────────────────────────────
rmSync(sandbox, { recursive: true, force: true });
rmSync(projDir, { recursive: true, force: true });

console.log('');
if (failed === 0) {
  console.log(chalk.green.bold(`✓ All ${passed} checks passed.`));
  process.exit(0);
} else {
  console.log(chalk.red.bold(`✗ ${failed} failed, ${passed} passed.`));
  process.exit(1);
}
