// Runtime QA agent core (brief 05 / P5a — missing-2). A self-contained,
// DIRECTLY-INVOCABLE module. Phase 89 (P5b) wires it into the auto-runner
// ready-for-qa transition (auto-runner.js runReadyForQaRuntimeGate, gating the
// three main-flow setProjectStatus('ready-for-qa') sites). runRuntimeQa launches
// the built app in the background, probes it (curl for APIs, CLI invocation for
// CLIs — no browser automation, no new packages), walks the QA journeys, and
// replies with a schema-validated verdict.
//
// The verify sandbox is read-only; validators never START the server, so a
// project can pass 25 bug rounds and reach ready-for-qa with an app that
// crashes on `npm start`. runtime-qa closes that gap by actually running the
// thing once, report-only.
//
// SECURITY-CRITICAL invariants (Opus-flagged):
//
//   1. FAIL CLOSED on an unresolvable sandbox. The agent is an UNATTENDED Bash
//      session. Its Bash deny profile comes from brief 04's LANDED deny-rule
//      mechanism (config.security.deny_rules + workspace-skills.mergeDenyRules,
//      the always-on PUSH_DENY_RULE). If that mechanism is unresolvable at load
//      time (import missing, or cfg carries no deny_rules array), runRuntimeQa
//      REFUSES to run — it returns a skipped result and makes NO Bash spawn. It
//      MUST NOT fall back to unrestricted Bash: unlike brief 06's notify_outbox
//      there is no plain-Bash fallback (mirrors portfolio-autopilot.resolveSandbox,
//      phase 86 — the SAME mechanism, not a second copy).
//
//   2. ORPHAN CLEANUP via signal to the process GROUP. The prompt instructs the
//      agent to append every background PID it starts to a pidfile and kill them
//      before finishing; the orchestrator backstops AFTER the call returns
//      (success OR error): probe each pid with process.kill(pid,0), SIGTERM the
//      pid's process GROUP (NEGATIVE pid), SIGKILL after a grace delay, then
//      delete the pidfile. Best-effort, NEVER throws — a stale/garbage/empty
//      pidfile is a no-op. Mirrors claude-runner's group-kill idiom: a POSITIVE
//      pid is negated exactly once for the group signal; double-negating would
//      degrade to a single-process kill and leak the server's children.
//
// Roleless/sessionless (role:null, sessionId:null, cwd=workspaceDir): a run
// never touches guide_session_id / last_dev_session_id — same session-safety
// class as runPhaseAcceptanceCheck / the review lenses / brief-conformance.
//
// Cache discipline (foundations cache-stable layout): RUNTIME_QA_SYSTEM_PROMPT is
// a fixed literal, byte-identical across every call (systemPromptExtra). All
// volatile values — the journeys, the pidfile path, the entrypoint, the verdict
// path — ride the per-call USER prompt (buildRuntimeQaPrompt), never the static
// block.

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import chalk from 'chalk';
import { runWithContract } from './llm-contract.js';
import { mergeDenyRules, mergeWorkspaceDenyRules, PUSH_DENY_RULE } from './workspace-skills.js';
import {
  qaJourneysPath, runtimeQaPath, planJsonPath,
} from './guide-paths.js';
import { activeBriefPath } from './brief-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ─── Verdict schema (ajv-compiled at load) ───────────────────────────────────
const RUNTIME_QA_SCHEMA_PATH = path.join(REPO_ROOT, 'config', 'schemas', 'runtime-qa.schema.json');
export const RUNTIME_QA_SCHEMA = JSON.parse(fs.readFileSync(RUNTIME_QA_SCHEMA_PATH, 'utf-8'));
const _ajv = new Ajv({ allErrors: true, strict: false });
// Compiled ONCE at module load — a malformed schema fails fast here, and the
// reply seam reuses this fn (passed as `validate`) rather than recompiling
// per call. Mirrors verify-loop.js's _validateVerdict.
const _validateVerdict = _ajv.compile(RUNTIME_QA_SCHEMA);

// Adapter for the P1 reply seam: given the tolerant-parsed reply object, return
// the {ok,value}|{ok,errors} contract runWithContract's `validate` path expects.
function validateVerdict(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['reply is not a JSON object'] };
  }
  if (!_validateVerdict(parsed)) {
    return { ok: false, errors: (_validateVerdict.errors || []).map((e) => `${e.instancePath || '(root)'} ${e.message}`) };
  }
  return { ok: true, value: parsed };
}

// ─── Tool sandbox ────────────────────────────────────────────────────────────
// Read tools + Bash. Bash is what distinguishes runtime-qa from the read-only
// acceptance checker (CHECKER_ALLOWED_TOOLS has NO Bash) — it must actually
// launch and probe a process. There is deliberately NO Write/Edit: the agent's
// final REPLY TEXT is the verdict (the reply seam), the orchestrator persists it.
// Bash itself is fenced by the config-driven deny_rules merged into the
// workspace's .claude/settings.json before the spawn (applyDenyRules below) —
// no curl to exfiltrate, no reads of secrets three dirs up, no git push.
export const RUNTIME_QA_ALLOWED_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Bash']);

// Grace between the group SIGTERM and the group SIGKILL in the orphan backstop.
export const ORPHAN_GRACE_MS = 2000;

// Fixed literal — byte-identical across every call by construction (no
// interpolation), satisfying the P1 cache-discipline rule for systemPromptExtra.
export const RUNTIME_QA_SYSTEM_PROMPT =
  `You are the Ashmero Orchestrator's runtime QA agent. You are invoked once per run to ` +
  `actually LAUNCH the already-built app and confirm it works at runtime — the acceptance ` +
  `checker and validators never start the process, so a project can reach ready-for-qa with ` +
  `an app that crashes on startup. Your job is to catch exactly that.\n\n` +
  `You have Read, Glob, Grep, and Bash. You have NO Write or Edit tool and MUST NOT modify ` +
  `the workspace. Bash is fenced by a deny-rule sandbox (no network exfiltration, no reads of ` +
  `files outside the workspace, no git push); do not attempt to work around it.\n\n` +
  `Method: launch the app in the BACKGROUND (never foreground a server — it never returns), ` +
  `probe it (curl/HTTP for a web/API server; direct CLI invocation for a CLI), walk each ` +
  `journey you are given, and record a per-journey status with concrete evidence. Do NOT use ` +
  `browser automation and do NOT install any package. Bound every command with a timeout so a ` +
  `hung server or test can never stall you.\n\n` +
  `PROCESS HYGIENE (mandatory): every background process you start, launch in its OWN process ` +
  `group (prefix with setsid, e.g. \`setsid <cmd> >/tmp/x.log 2>&1 & echo $! >> "$PIDFILE"\`) ` +
  `and append its PID to the pidfile whose absolute path is given in the task. Before you ` +
  `finish, kill every process you started. The orchestrator backstops your cleanup, but you ` +
  `are the primary owner — leave nothing running.\n\n` +
  `Your ONLY output is a single JSON verdict object as your final reply — no markdown fence, ` +
  `no other prose. Report honestly: a journey you could not run is "skipped" or "blocked", ` +
  `never "pass".`;

// ─── Fail-closed sandbox guard ───────────────────────────────────────────────
//
// Resolve brief 04's config-driven deny-rule sandbox at load time — the SAME
// mechanism the P7 autopilot (portfolio-autopilot.resolveSandbox) gates on.
// "Resolvable" means the merge primitive + the always-on push guard are
// importable AND the config layer carries a `security.deny_rules` array (so the
// spawned Bash session runs under real deny rules). If ANY of that is missing
// runtime-qa FAILS CLOSED: no fallback, because an unattended Bash agent without
// deny rules is never acceptable.
//
// @param {object} cfg - a resolved config (reads security.deny_rules)
// @returns {{ ok: boolean, reason: string|null }}
export function resolveSandbox(cfg) {
  if (typeof mergeDenyRules !== 'function' || typeof mergeWorkspaceDenyRules !== 'function') {
    return { ok: false, reason: 'brief-04 sandbox unresolvable: deny-rule merge primitive is not importable' };
  }
  if (typeof PUSH_DENY_RULE !== 'string' || !PUSH_DENY_RULE) {
    return { ok: false, reason: 'brief-04 sandbox unresolvable: PUSH_DENY_RULE is missing' };
  }
  if (!cfg || !cfg.security || !Array.isArray(cfg.security.deny_rules)) {
    return { ok: false, reason: 'brief-04 sandbox unresolvable: cfg.security.deny_rules is not an array' };
  }
  return { ok: true, reason: null };
}

// ─── Entrypoint detection ────────────────────────────────────────────────────
//
// Answers "is there something to launch?" from package.json alone (no new deps,
// no filesystem heuristics beyond it). A start/serve/dev script → a server; a
// `bin` entry → a CLI. No package.json / no runnable entry → not found, and with
// runtime_qa.skip_when_no_entrypoint true the caller skips the whole agent.
//
// @param {string} workspaceDir
// @param {{ readFile?: Function }} [deps]
// @returns {Promise<{ found: boolean, kind: string|null, command: string|null, detail: string }>}
export async function detectEntrypoint(workspaceDir, { readFile = fsp.readFile } = {}) {
  let raw;
  try {
    raw = await readFile(path.join(workspaceDir, 'package.json'), 'utf-8');
  } catch {
    return { found: false, kind: null, command: null, detail: 'no package.json' };
  }
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return { found: false, kind: null, command: null, detail: 'unparseable package.json' };
  }
  const scripts = (pkg && typeof pkg.scripts === 'object' && pkg.scripts) || {};
  for (const [key, cmd] of [['start', 'npm start'], ['serve', 'npm run serve'], ['dev', 'npm run dev']]) {
    if (typeof scripts[key] === 'string' && scripts[key].trim()) {
      return { found: true, kind: 'server', command: cmd, detail: `scripts.${key}: ${scripts[key]}` };
    }
  }
  if (pkg && pkg.bin) {
    if (typeof pkg.bin === 'string' && pkg.bin.trim()) {
      return { found: true, kind: 'cli', command: `node ${pkg.bin}`, detail: `bin: ${pkg.name || pkg.bin}` };
    }
    if (typeof pkg.bin === 'object') {
      const names = Object.keys(pkg.bin);
      if (names.length) {
        return { found: true, kind: 'cli', command: `node ${pkg.bin[names[0]]}`, detail: `bin: ${names[0]}` };
      }
    }
  }
  return { found: false, kind: null, command: null, detail: 'no start/serve/dev script or bin entry' };
}

// ─── QA journeys (volatile — per-call user prompt) ───────────────────────────
//
// Primary source: .guide/qa-journeys.json ([{ name, steps }]) written by the
// handoff-creation guide task. Fallback when absent: the brief's Definition-of-done
// section verbatim (backward-compat NFR — an old project with no qa-journeys.json
// must still get SOMETHING to walk). Neither present → a generic smoke instruction.

function renderJourneys(journeys) {
  const lines = [];
  journeys.forEach((j, i) => {
    if (!j || typeof j.name !== 'string') return;
    lines.push(`${i + 1}. ${j.name}`);
    const steps = Array.isArray(j.steps) ? j.steps : [];
    for (const s of steps) {
      if (typeof s === 'string' && s.trim()) lines.push(`   - ${s.trim()}`);
    }
  });
  return lines.join('\n');
}

// Extract the verbatim "## Definition of done" section (heading through the next
// same-or-higher-level heading) from a brief markdown string. Returns '' when no
// such section exists.
export function extractDefinitionOfDone(briefText) {
  const text = String(briefText ?? '');
  const lines = text.split('\n');
  let start = -1;
  let headingLevel = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(#{1,6})\s+.*definition[\s-]of[\s-]done/i);
    if (m) { start = i; headingLevel = m[1].length; break; }
  }
  if (start < 0) return '';
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    const h = lines[i].match(/^(#{1,6})\s+/);
    if (h && h[1].length <= headingLevel) break; // next same/higher section ends it
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

export async function loadJourneysBlock({ projDir, cfg }, { readFile = fsp.readFile } = {}) {
  // 1. qa-journeys.json (primary).
  try {
    const parsed = JSON.parse(await readFile(qaJourneysPath(projDir), 'utf-8'));
    if (Array.isArray(parsed) && parsed.length) {
      const rendered = renderJourneys(parsed);
      if (rendered.trim()) return { source: 'qa-journeys', text: rendered };
    }
  } catch { /* fall through to the brief DoD */ }

  // 2. Brief Definition-of-done section (verbatim fallback).
  try {
    let plan = null;
    try { plan = JSON.parse(await readFile(planJsonPath(projDir), 'utf-8')); } catch { /* no plan */ }
    const briefFile = activeBriefPath(projDir, plan);
    const dod = extractDefinitionOfDone(await readFile(briefFile, 'utf-8'));
    if (dod) return { source: 'brief-dod', text: dod };
  } catch { /* fall through to the generic smoke block */ }

  // 3. Nothing on disk — a generic smoke instruction so the agent still runs.
  return {
    source: 'none',
    text: 'No QA journeys or Definition-of-done were available. Run a basic smoke test: launch the '
      + 'app, confirm it starts without crashing, and probe its primary entrypoint once.',
  };
}

// ─── Per-call user prompt (volatile) ─────────────────────────────────────────
export function buildRuntimeQaPrompt({ journeysBlock, journeysSource, pidfilePath, entrypoint, relVerdictPath }) {
  const entryLine = entrypoint?.found
    ? `Detected entrypoint (${entrypoint.kind}): ${entrypoint.command} — ${entrypoint.detail}`
    : 'No entrypoint was auto-detected — inspect the workspace and launch the app however it is meant to run.';
  return `Runtime-QA this project. ${entryLine}

Pidfile (absolute): ${pidfilePath}
Export it first so your launch commands can append to it:
  export PIDFILE="${pidfilePath}"
Every background process you start MUST be launched in its own process group and its PID appended to $PIDFILE, e.g.:
  setsid ${entrypoint?.command || '<launch-cmd>'} >/tmp/rqa.log 2>&1 & echo $! >> "$PIDFILE"

Walk these journeys (probe with curl/HTTP for a server, direct invocation for a CLI):
${journeysBlock}
(journey source: ${journeysSource})

When done, KILL every process you started (kill the PIDs in $PIDFILE), then reply with EXACTLY one JSON object — no markdown fence, no prose — matching:
{
  "journeys": [{ "name": "<journey name>", "status": "pass|fail|blocked|skipped", "evidence": "<what you observed>" }],
  "blockers": [{ "title": "<short>", "detail": "<what breaks and how>", "severity": "<blocker|major|minor>" }],
  "notes": "<optional overall notes>"
}
Do NOT write ${relVerdictPath} yourself — you have no Write tool; the orchestrator persists your reply.`;
}

// ─── Orphan-pid backstop ─────────────────────────────────────────────────────
//
// Read the pidfile, kill each still-alive pid's process GROUP, delete the file.
// Best-effort and NEVER throws — a missing/empty/garbage pidfile is a clean
// no-op. Runs AFTER the agent returns (success OR error).
//
// Safety: we only ever signal the group of a POSITIVE pid we confirmed alive,
// negated exactly once (process.kill(-pid, sig)). pid<=1 and our OWN pid are
// skipped so a garbage line can never signal init or the orchestrator itself.
export async function cleanupOrphanPids(pidfilePath, {
  graceMs = ORPHAN_GRACE_MS,
  kill = (pid, sig) => process.kill(pid, sig),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now: _now,
  log = () => {},
} = {}) {
  let content;
  try {
    content = await fsp.readFile(pidfilePath, 'utf-8');
  } catch {
    return { killed: [], reason: 'no pidfile' }; // missing/unreadable → nothing to clean up
  }

  const pids = [];
  for (const tok of String(content).split(/\s+/)) {
    const n = Number.parseInt(tok.trim(), 10);
    // pid must be a real, positive, non-init pid, and never our own process.
    if (Number.isInteger(n) && n > 1 && n !== process.pid && !pids.includes(n)) pids.push(n);
  }

  const alive = [];
  for (const pid of pids) {
    // Liveness probe: process.kill(pid, 0) throws ESRCH when the pid is gone.
    try { kill(pid, 0); } catch { continue; }
    // SIGTERM the process GROUP (negative pid — negated exactly once here).
    try { kill(-pid, 'SIGTERM'); alive.push(pid); } catch { /* no group / race — best effort */ }
  }

  if (alive.length) {
    try { await sleep(graceMs); } catch { /* ignore */ }
    for (const pid of alive) {
      try { kill(-pid, 'SIGKILL'); } catch { /* already dead */ }
    }
  }

  try { await fsp.unlink(pidfilePath); } catch { /* already gone */ }
  if (alive.length) log(`[runtime-qa] orphan backstop: signalled process group(s) ${alive.join(', ')}`);
  return { killed: alive };
}

// The report-class fail-open verdict: report-mode runtime-qa never blocks, so an
// unparseable reply (even after the one re-ask) degrades to an inconclusive
// verdict with no journeys/blockers — persisted like any other, marked _status.
function buildInconclusiveVerdict(errors) {
  const detail = (errors || []).join('; ') || 'no valid verdict was produced';
  return {
    journeys: [],
    blockers: [],
    notes: `runtime-qa produced no valid verdict after one re-ask — inconclusive (fail-open, report mode). ${detail}`,
    _status: 'inconclusive',
  };
}

async function persistVerdict(verdictPath, verdict) {
  await fsp.mkdir(path.dirname(verdictPath), { recursive: true });
  await fsp.writeFile(verdictPath, JSON.stringify(verdict, null, 2), 'utf-8');
}

// ─── Verdict summary (pure) ──────────────────────────────────────────────────
//
// One-line human summary of a runRuntimeQa result, shared by phase 89's
// ready-for-qa gate for BOTH its dim log line and its single per-run notifier
// line (so the two never drift). Pure — no I/O. Tolerant of a missing/inconclusive
// verdict (fail-open reports carry journeys:[]/blockers:[]).
export function summarizeRuntimeQaVerdict(result) {
  const verdict = result?.verdict || {};
  const journeys = Array.isArray(verdict.journeys) ? verdict.journeys : [];
  const blockers = Array.isArray(verdict.blockers) ? verdict.blockers : [];
  const passed = journeys.filter((j) => j && j.status === 'pass').length;
  const statusWord = result?.status === 'inconclusive' ? 'inconclusive' : 'ran';
  const blockerNote = blockers.length ? `${blockers.length} blocker(s)` : 'no blockers';
  return `runtime-qa ${statusWord}: ${passed}/${journeys.length} journeys passed, ${blockerNote}`;
}

/**
 * Run the runtime-QA agent against a workspace. Self-contained and directly
 * invocable; phase 89 (P5b) wires it into the ready-for-qa transition via
 * auto-runner.js runReadyForQaRuntimeGate.
 *
 * @param {Object} args
 * @param {string} args.projectName
 * @param {string} args.workspaceDir - absolute path to the project's workspace/ (the spawn cwd)
 * @param {Object} args.cfg - resolved config (reads models['runtime-qa'], security.deny_rules, runtime_qa.*)
 * @param {Function} [args.callFn] - injectable runClaude seam threaded into the reply contract
 * @param {Object} [deps] - test seams (each defaults to the production impl)
 * @returns {Promise<{status:'ok'|'inconclusive'|'skipped', reason:string|null, verdict:object|null,
 *   verdictPath:string, spawned:boolean, appliedDenyRules?:string[], entrypoint?:object,
 *   journeysSource?:string, reasks?:number}>}
 */
export async function runRuntimeQa({ projectName, workspaceDir, cfg, callFn }, deps = {}) {
  const {
    resolveSandbox: resolveSandboxFn = resolveSandbox,
    detectEntrypoint: detectEntrypointFn = detectEntrypoint,
    applyDenyRules: applyDenyRulesFn = mergeWorkspaceDenyRules,
    loadJourneysBlock: loadJourneysFn = loadJourneysBlock,
    cleanupOrphanPids: cleanupFn = cleanupOrphanPids,
    runWithContract: runWithContractFn = runWithContract,
    now = () => Date.now(),
    graceMs = ORPHAN_GRACE_MS,
    log = (m) => console.log(chalk.dim(m)),
  } = deps;

  const absWorkspace = path.resolve(workspaceDir);
  const projDir = path.dirname(absWorkspace);
  const verdictPath = runtimeQaPath(projDir);

  // 1. FAIL CLOSED: an unresolvable deny-rule sandbox refuses to run — no spawn.
  const sandbox = resolveSandboxFn(cfg);
  if (!sandbox.ok) {
    log(`[runtime-qa] ${sandbox.reason} — refusing to run (fail closed, no Bash spawn)`);
    return { status: 'skipped', reason: sandbox.reason, verdict: null, verdictPath, spawned: false };
  }

  // 2. Entrypoint detection (skip when none + skip_when_no_entrypoint).
  const entrypoint = await detectEntrypointFn(absWorkspace);
  if (!entrypoint.found && cfg?.runtime_qa?.skip_when_no_entrypoint !== false) {
    const reason = `no start script or CLI entrypoint detected (${entrypoint.detail})`;
    log(`[runtime-qa] ${reason} — skipping (runtime_qa.skip_when_no_entrypoint)`);
    return { status: 'skipped', reason, verdict: null, verdictPath, spawned: false, entrypoint };
  }

  // 3. Apply the deny-rule sandbox to the workspace the Bash spawn runs in — the
  //    landed mechanism (merge into .claude/settings.json + always-on push guard).
  //    A failure to apply it FAILS CLOSED too: we never spawn unrestricted Bash.
  const denyRules = Array.isArray(cfg.security?.deny_rules) ? cfg.security.deny_rules : [];
  try {
    await applyDenyRulesFn(absWorkspace, denyRules);
  } catch (err) {
    const reason = `failed to apply deny-rule sandbox to workspace: ${err.message}`;
    log(`[runtime-qa] ${reason} — refusing to run (fail closed, no Bash spawn)`);
    return { status: 'skipped', reason, verdict: null, verdictPath, spawned: false, entrypoint };
  }

  // 4. Journeys (volatile) + pidfile (absolute, outside the git tree).
  const journeys = await loadJourneysFn({ projDir, cfg });
  const pidfilePath = path.join(os.tmpdir(), `runtime-qa-pids-${projectName}-${now()}.txt`);
  try {
    await fsp.mkdir(path.dirname(pidfilePath), { recursive: true });
    await fsp.writeFile(pidfilePath, '', 'utf-8');
  } catch { /* the agent will create it on first append; cleanup no-ops if absent */ }

  const relVerdictPath = path.relative(absWorkspace, verdictPath);
  const prompt = buildRuntimeQaPrompt({
    journeysBlock: journeys.text, journeysSource: journeys.source, pidfilePath, entrypoint, relVerdictPath,
  });

  const qaCfg = { ...cfg, model: cfg.models?.['runtime-qa'] };
  delete qaCfg._effort_override;

  const baseCall = {
    cfg: qaCfg,
    cwd: absWorkspace,
    systemPromptFile: null,
    systemPromptExtra: RUNTIME_QA_SYSTEM_PROMPT,
    allowedToolsOverride: [...RUNTIME_QA_ALLOWED_TOOLS],
    role: null,
    project: projectName,
    task: 'runtime-qa',
  };

  // 5. Spawn under the P1 reply contract: schema-validated, EXACTLY one
  //    session-resumed re-ask on invalid JSON, no escalation. Cleanup ALWAYS
  //    runs (success OR error) via the finally.
  let contract;
  try {
    contract = await runWithContractFn({
      baseCall,
      prompt,
      sessionId: null,
      validate: validateVerdict, // load-compiled ajv fn (reply seam)
      maxReasks: 1,
      escalateOnSecondFail: false,
      runClaude: callFn,
    });
  } finally {
    await cleanupFn(pidfilePath, { graceMs, log });
  }

  // 6. Resolve the verdict — fail-open to inconclusive (report-class default).
  let verdict;
  let status;
  if (contract?.ok) {
    verdict = contract.value;
    status = 'ok';
  } else {
    verdict = buildInconclusiveVerdict(contract?.errors);
    status = 'inconclusive';
    log('[runtime-qa] no valid verdict after re-ask — writing inconclusive fail-open verdict');
  }

  // 7. Persist the verdict VERBATIM.
  await persistVerdict(verdictPath, verdict);

  return {
    status,
    reason: null,
    verdict,
    verdictPath,
    spawned: true,
    appliedDenyRules: denyRules,
    entrypoint,
    journeysSource: journeys.source,
    reasks: contract?.reasks ?? 0,
  };
}
