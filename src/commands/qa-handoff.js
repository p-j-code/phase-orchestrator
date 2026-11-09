// QA Handoff generator v0.11 — produces a tester-friendly markdown checklist
// from the orchestrator's artifacts (bugs.md, fix reports, validator runs,
// git history, project context).
//
// Two modes:
//   extractive (default) — zero API calls, fast, dumps everything in a structured form
//   --with-steps         — one Opus call that converts technical Acceptance into
//                          plain-tester manual test procedures
//
// Scope:
//   --round <n>        a specific bug round
//   --phases <a>:<b>   a phase range
//   --last-round       most recent bug round (default if no flag given)
//   --last-phases      from project's current_phase down to 1 (or capped)

import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import ora from 'ora';

import { getProject, getDb } from '../state.js';
import { resolve as resolveConfig } from '../config-resolver.js';
import { routeModel } from '../model-router.js';
import { runClaude } from '../claude-runner.js';
import {
  planJsonPath, bugsFilePath, fixPlanJsonPath, fixPlanMdPath,
  fixDir, fixReportPath, bugRoundDir, phaseDir, phaseReportPath,
  projectContextPath, qaHandoffsDir, qaHandoffPath, detectHighestBugRound,
  shipGateReportPath, briefConformanceMdPath,
} from '../lib/guide-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

// ─── Parsing bugs.md ────────────────────────────────────────────────────────

/**
 * Parses a bugs.md file into structured bug entries. Tolerant of formatting
 * variations — entries with missing sections still parse.
 *
 * @returns {Array<{n, severity, title, repro, expected, acceptance}>}
 */
function parseBugsFile(text) {
  if (!text) return [];
  // Split on `## BUG-N` headers
  const bugBlocks = text.split(/^##\s+BUG-/m).slice(1);
  return bugBlocks.map((block) => {
    const headerMatch = block.match(/^(\d+)\s*\(([^)]+)\)\s*:\s*(.+?)$/m);
    const n = headerMatch ? Number(headerMatch[1]) : null;
    const severity = headerMatch ? headerMatch[2].trim().toUpperCase() : 'UNKNOWN';
    const title = headerMatch ? headerMatch[3].trim() : block.split('\n')[0].slice(0, 80);

    const repro = extractSection(block, 'Repro');
    const expected = extractSection(block, 'Expected');
    const acceptance = extractSection(block, 'Acceptance');

    return { n, severity, title, repro, expected, acceptance };
  }).filter((b) => b.n !== null);
}

function extractSection(block, label) {
  // Matches `**Label:** ...` until the next `**Label:**` or `##` or end
  const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*([\\s\\S]+?)(?=\\n\\*\\*[A-Z][a-z]+:\\*\\*|\\n## |$)`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

// ─── Validator stats ───────────────────────────────────────────────────────

function getValidatorStats(projectName, { round = null, phaseRange = null }) {
  const db = getDb();
  let rows;
  if (round != null) {
    rows = db.prepare(
      `SELECT validator_name, status, fix_round, fix_n, started_at, exit_code, stderr_excerpt
       FROM validator_runs WHERE project = ? AND fix_round = ? ORDER BY started_at ASC`,
    ).all(projectName, round);
  } else if (phaseRange) {
    const [start, end] = phaseRange;
    rows = db.prepare(
      `SELECT validator_name, status, phase, started_at, exit_code, stderr_excerpt
       FROM validator_runs WHERE project = ? AND phase BETWEEN ? AND ? ORDER BY started_at ASC`,
    ).all(projectName, start, end);
  } else {
    rows = [];
  }
  // Aggregate by validator
  const byValidator = {};
  for (const r of rows) {
    if (!byValidator[r.validator_name]) byValidator[r.validator_name] = { pass: 0, fail: 0, failures: [] };
    if (r.status === 'pass') byValidator[r.validator_name].pass += 1;
    else {
      byValidator[r.validator_name].fail += 1;
      byValidator[r.validator_name].failures.push(r);
    }
  }
  // Per-fix lookup (which validators ran for fix N)
  const byFix = {};
  for (const r of rows.filter((x) => x.fix_n != null)) {
    const key = `${r.fix_round}.${r.fix_n}`;
    if (!byFix[key]) byFix[key] = [];
    byFix[key].push({ name: r.validator_name, status: r.status });
  }
  const byPhase = {};
  for (const r of rows.filter((x) => x.phase != null)) {
    if (!byPhase[r.phase]) byPhase[r.phase] = [];
    byPhase[r.phase].push({ name: r.validator_name, status: r.status });
  }
  return { byValidator, byFix, byPhase, total: rows.length };
}

// ─── Cost / time stats ─────────────────────────────────────────────────────

function getCallStats(projectName, { round = null, phaseRange = null }) {
  const db = getDb();
  // Determine time window — easier: pull all calls where phase/round metadata matches
  let rows;
  if (round != null) {
    // Calls related to this round have task in {bug-plan, fix-prompt-gen, fix-execution}
    // and started during the round. We approximate by joining via bug_rounds table.
    const round_row = db.prepare(
      `SELECT started_at, ended_at FROM bug_rounds WHERE project = ? AND round = ?`,
    ).get(projectName, round);
    if (!round_row) return null;
    const endClause = round_row.ended_at ? `AND started_at <= '${round_row.ended_at}'` : '';
    rows = db.prepare(
      `SELECT model, task, cost_usd, duration_ms, input_tokens, output_tokens, is_error
       FROM calls WHERE project = ? AND started_at >= ? ${endClause}`,
    ).all(projectName, round_row.started_at);
  } else if (phaseRange) {
    const [start, end] = phaseRange;
    rows = db.prepare(
      `SELECT model, task, cost_usd, duration_ms, input_tokens, output_tokens, is_error
       FROM calls WHERE project = ? AND phase BETWEEN ? AND ?`,
    ).all(projectName, start, end);
  } else {
    rows = [];
  }
  let cost = 0, dur = 0, inTok = 0, outTok = 0, errors = 0;
  const byTask = {};
  for (const r of rows) {
    cost += r.cost_usd || 0;
    dur += r.duration_ms || 0;
    inTok += r.input_tokens || 0;
    outTok += r.output_tokens || 0;
    if (r.is_error) errors += 1;
    byTask[r.task] = (byTask[r.task] || 0) + 1;
  }
  return { totalCalls: rows.length, cost, dur, inTok, outTok, errors, byTask };
}

// ─── Git history ───────────────────────────────────────────────────────────

function getGitCommits(workspaceDir, sinceISO) {
  try {
    const cmd = `git -C "${workspaceDir}" log --since="${sinceISO}" --pretty=format:"%h|%s|%ad" --date=iso-strict`;
    const out = execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.trim().split('\n').filter(Boolean).map((line) => {
      const [sha, subject, date] = line.split('|');
      return { sha, subject, date };
    });
  } catch {
    return null; // no git, or git error
  }
}

// ─── Fix → Bug matching ─────────────────────────────────────────────────────

function matchFixesToBugs(fixes, bugs) {
  // For each fix, find which bug numbers it references in title or report body.
  // Returns Map<bugN, fix[]>.
  const map = new Map();
  for (const b of bugs) map.set(b.n, []);
  const unmatched = [];

  for (const fix of fixes) {
    const haystack = [fix.title || '', fix.description || '', fix.notes || '', fix.what || '']
      .join(' ');
    const refs = [...haystack.matchAll(/BUG[-_ ]?(\d+)/gi)].map((m) => Number(m[1]));
    if (refs.length === 0) {
      unmatched.push(fix);
      continue;
    }
    for (const ref of refs) {
      if (map.has(ref)) map.get(ref).push(fix);
    }
  }
  return { byBug: map, unmatched };
}

// ─── Output assembly (extractive mode) ──────────────────────────────────────

async function buildExtractive({ projectName, scope, bugs, fixes, fixReports, fixesByBug, unmatchedFixes, validators, callStats, commits, projectMeta }) {
  const lines = [];
  const ts = new Date();
  const tsStr = ts.toISOString().slice(0, 10);

  lines.push(`# QA Handoff — ${projectName} — ${scope.label}`);
  lines.push('');
  lines.push(`> Generated ${tsStr} by orchestrator v0.11`);
  lines.push('> Hand this document to QA. Tick checkboxes as items are verified.');
  lines.push('> File issues for any failure against the relevant commit SHA shown next to each item.');
  lines.push('');

  lines.push('## Tester info');
  lines.push('');
  lines.push('- Tested by: ___________________');
  lines.push('- Date:       ___________________');
  lines.push('- Branch:     ___________________');
  lines.push('- Build/SHA:  ___________________');
  lines.push('');

  lines.push('## Quick stats');
  lines.push('');
  const bySev = countBy(bugs, (b) => b.severity);
  const sevStr = Object.entries(bySev).map(([s, n]) => `${n} ${s.toLowerCase()}`).join(', ');
  lines.push(`- **Bugs addressed:** ${bugs.length}${sevStr ? ` (${sevStr})` : ''}`);
  lines.push(`- **Fixes executed:** ${fixes.length}`);
  if (validators.total > 0) {
    const valStrs = Object.entries(validators.byValidator).map(([name, s]) =>
      `${name} ${s.pass}/${s.pass + s.fail}${s.fail > 0 ? ' ✗' : ' ✓'}`);
    lines.push(`- **Auto-validators:** ${valStrs.join(' · ')}`);
  } else {
    lines.push(`- **Auto-validators:** none configured / none ran`);
  }
  if (callStats) {
    const wallDuration = formatDuration(callStats.dur);
    lines.push(`- **Calls:** ${callStats.totalCalls}${callStats.errors > 0 ? ` (${callStats.errors} errored)` : ''}`);
    lines.push(`- **Cost (Max-equiv):** $${callStats.cost.toFixed(2)}`);
    lines.push(`- **Time in calls:** ${wallDuration}`);
  }
  if (commits && commits.length > 0) {
    const range = `${commits[commits.length - 1].sha}..${commits[0].sha}`;
    lines.push(`- **Commits:** ${commits.length} (${range})`);
  }
  lines.push('');

  // Group bugs by severity
  const order = ['CRITICAL', 'MAJOR', 'MINOR', 'UNKNOWN'];
  const grouped = {};
  for (const sev of order) grouped[sev] = [];
  for (const b of bugs) grouped[b.severity in grouped ? b.severity : 'UNKNOWN'].push(b);

  for (const sev of order) {
    const bugsOfSev = grouped[sev];
    if (bugsOfSev.length === 0) continue;
    lines.push('---');
    lines.push('');
    lines.push(`## ${sev}`);
    lines.push('');

    for (const bug of bugsOfSev) {
      lines.push(`### \`[ ]\` BUG-${bug.n} — ${bug.title}`);
      lines.push('');

      const matchedFixes = fixesByBug.get(bug.n) || [];
      const fixMeta = matchedFixes.length > 0
        ? matchedFixes.map((f) => `r${scope.round || '?'}.${f.n}`).join(', ')
        : 'no explicit fix mapping found';
      lines.push(`**Severity:** ${bug.severity}  •  **Fix:** ${fixMeta}`);

      // Validator results for any matched fix
      const validatorsForBug = matchedFixes.flatMap((f) => validators.byFix[`${scope.round}.${f.n}`] || []);
      if (validatorsForBug.length > 0) {
        const vs = countBy(validatorsForBug, (v) => v.name);
        const validatorLine = Object.entries(vs).map(([name, n]) => {
          const failures = validatorsForBug.filter((v) => v.name === name && v.status === 'fail').length;
          return failures > 0 ? `${name} ${chalk ? '✗' : 'FAIL'}` : `${name} ✓`;
        }).join(' · ');
        lines.push(`**Auto-checks:** ${validatorLine}`);
      }
      lines.push('');

      if (bug.repro) {
        lines.push('**What was happening:**');
        lines.push('');
        lines.push(reflow(bug.repro, '> '));
        lines.push('');
      }
      if (bug.expected) {
        lines.push('**Expected behavior:**');
        lines.push('');
        lines.push(reflow(bug.expected, '> '));
        lines.push('');
      }
      if (bug.acceptance) {
        lines.push('**Acceptance (technical):**');
        lines.push('');
        lines.push(reflow(bug.acceptance, '> '));
        lines.push('');
      }

      // Fix report excerpts
      for (const fix of matchedFixes) {
        const report = fixReports[fix.n];
        if (!report) continue;
        lines.push(`**Fix r${scope.round}.${fix.n} — ${fix.title || ''}:**`);
        const excerpt = report.slice(0, 800).split('\n').map((l) => '> ' + l).join('\n');
        lines.push('');
        lines.push(excerpt);
        if (report.length > 800) lines.push(`> _…(report continues, ${report.length} chars total — see .guide/bug-rounds/round-${scope.round}/fixes/${zeroPad(fix.n)}-*/report.md)_`);
        lines.push('');
      }

      // Verify checkboxes (derived heuristically from acceptance section)
      const verifyItems = extractVerifyItems(bug);
      if (verifyItems.length > 0) {
        lines.push('**Verify:**');
        lines.push('');
        for (const v of verifyItems) lines.push(`- \`[ ]\` ${v}`);
        lines.push('');
      }

      lines.push('');
    }
  }

  // Unmatched fixes section
  if (unmatchedFixes.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## Fixes without explicit bug mapping');
    lines.push('');
    lines.push('(The fix titles didn\'t reference a `BUG-N` number. Manual review needed to map these to test coverage.)');
    lines.push('');
    for (const fix of unmatchedFixes) {
      lines.push(`### \`[ ]\` Fix r${scope.round}.${fix.n} — ${fix.title || '(no title)'}`);
      const report = fixReports[fix.n];
      if (report) {
        const firstPara = report.split('\n\n')[0] || report.slice(0, 400);
        lines.push('');
        lines.push(reflow(firstPara, '> '));
      }
      lines.push('');
    }
  }

  // Validator failures requiring re-verify
  const allFailures = Object.entries(validators.byValidator)
    .filter(([, s]) => s.fail > 0)
    .flatMap(([name, s]) => s.failures.map((f) => ({ ...f, validatorName: name })));
  if (allFailures.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## ⚠ Validator failures — extra scrutiny needed');
    lines.push('');
    lines.push('These validators failed on at least one fix. The fix may still have shipped (manual review at the time decided to proceed). Worth re-running and re-verifying:');
    lines.push('');
    for (const f of allFailures) {
      const where = f.fix_n != null ? `fix r${f.fix_round}.${f.fix_n}` : `phase ${f.phase}`;
      lines.push(`- \`[ ]\` **${f.validatorName}** failed on ${where} (exit ${f.exit_code})`);
      if (f.stderr_excerpt) {
        const tail = f.stderr_excerpt.split('\n').slice(-3).join('\n').trim();
        if (tail) {
          lines.push('');
          lines.push('  ```');
          lines.push('  ' + tail.split('\n').join('\n  '));
          lines.push('  ```');
        }
      }
      lines.push(`  - Re-run: \`npm run validate -- ${projectName} --fix ${f.fix_round}.${f.fix_n}\``);
    }
    lines.push('');
  }

  // Git history
  if (commits && commits.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## Commits in this scope');
    lines.push('');
    lines.push('```');
    for (const c of commits.slice(0, 50)) {
      lines.push(`${c.sha}  ${c.subject}`);
    }
    if (commits.length > 50) lines.push(`...and ${commits.length - 50} more`);
    lines.push('```');
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push('');
  lines.push('## Sign-off');
  lines.push('');
  lines.push(`- \`[ ]\` All items above verified`);
  lines.push(`- \`[ ]\` No regression observed in adjacent features (dashboard, invoice list, party management)`);
  lines.push(`- \`[ ]\` Approved for production`);
  lines.push('');
  lines.push('Signed: ___________________     Date: ___________________');
  lines.push('');

  return lines.join('\n');
}

function extractVerifyItems(bug) {
  // Heuristic: parse the acceptance section for verifiable statements.
  // Each sentence or bullet that mentions an observable outcome becomes a checkbox.
  if (!bug.acceptance) return [];
  const items = [];
  // Bullets in the acceptance
  const bullets = bug.acceptance.match(/^[-*]\s+(.+)$/gm);
  if (bullets) {
    for (const b of bullets) items.push(b.replace(/^[-*]\s+/, '').trim());
  } else {
    // Split on sentence-ish punctuation
    const sentences = bug.acceptance.split(/(?<=[.;])\s+/).filter((s) => s.length > 12);
    items.push(...sentences.slice(0, 4));
  }
  return items.slice(0, 6).map((s) => s.replace(/\.$/, ''));
}

// ─── Output assembly (LLM-augmented mode) ──────────────────────────────────

async function withSteps({ projectName, bugs, fixesByBug, fixReports, projectMeta }) {
  // Single batched Opus call: send all bugs + matched fix reports, ask for
  // tester-friendly manual test procedures.
  if (bugs.length === 0) return null;

  const cfg = await resolveConfig({ project: projectName, task: 'audit' });
  // v0.14.35: route like every other call site instead of reading
  // cfg.models.audit directly. Pre-v0.14.35 this bypassed routeModel, so the
  // hard_floors.audit=opus never applied and the "batched Opus call" below
  // actually ran Sonnet (models.audit baseline). Now the floor decides — flip
  // hard_floors.audit to sonnet later if /spend says Opus isn't earning it here.
  const routing = await routeModel({ cfg, task: 'audit', projectName });
  cfg.model = routing.model;

  let contextExtra = null;
  const projDir = path.join(PROJECTS_DIR, projectName);
  try {
    const ctx = await fs.readFile(projectContextPath(projDir), 'utf-8');
    if (ctx.trim()) contextExtra = `<project_context>\n${ctx.trim()}\n</project_context>`;
  } catch { /* no context file */ }

  const bugBlocks = bugs.map((b) => {
    const matched = fixesByBug.get(b.n) || [];
    const reports = matched.map((f) => fixReports[f.n]).filter(Boolean).join('\n\n').slice(0, 2000);
    return [
      `## BUG-${b.n} (${b.severity}): ${b.title}`,
      b.repro ? `Repro: ${b.repro}` : '',
      b.expected ? `Expected: ${b.expected}` : '',
      b.acceptance ? `Acceptance: ${b.acceptance}` : '',
      reports ? `Fix reports:\n${reports}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n---\n\n');

  const prompt = `You are writing QA test procedures for a non-technical tester to verify each bug fix. The tester knows the product but does NOT know the code.

For each BUG entry below, output a JSON object with:
- "n": the bug number
- "setup": 1-3 preconditions the tester needs (e.g., "Log in as a business owner with at least one customer party")
- "steps": numbered array of imperative actions in plain English (e.g., "Open any invoice", "Click the Send Email button"). Each step under 20 words. No jargon like "route", "endpoint", "ObjectId" — use product terms like "page", "form", "button".
- "verify": array of observable outcomes the tester checks (e.g., "Email arrives in customer inbox within 60 seconds", "Invoice status badge updates to 'sent'"). Boolean pass/fail per item.
- "regressions": array of 1-3 nearby features that share code with this fix and should be sanity-checked

Respond with ONLY a JSON array of these objects, no preamble, no markdown fences. Preserve bug order.

${bugBlocks}`;

  const result = await runClaude({
    cfg, cwd: REPO_ROOT, prompt,
    systemPromptFile: null,
    systemPromptExtra: contextExtra,
    role: 'guide', project: projectName, task: 'audit',
  });
  if (result.is_error) throw new Error(result.error_message || 'qa-handoff LLM call failed');

  const text = (result.result || '').replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`could not parse LLM JSON: ${err.message}\nFirst 500 chars: ${text.slice(0, 500)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('LLM response was not an array');

  // Index by bug number for easy injection
  const byN = {};
  for (const item of parsed) {
    if (item && item.n != null) byN[item.n] = item;
  }
  return byN;
}

function injectStepsIntoMarkdown(markdown, stepsByN) {
  if (!stepsByN) return markdown;
  // Find each BUG-N section and insert manual test steps before "Acceptance" or before "Verify"
  return markdown.replace(
    /(### `\[ \]` BUG-(\d+) — [^\n]+\n[\s\S]+?)(\*\*Verify:\*\*)/g,
    (whole, before, n, verifyHeader) => {
      const step = stepsByN[Number(n)];
      if (!step) return whole;
      const block = renderManualSteps(step);
      // Replace heuristic Verify with LLM-generated verify
      const llmVerify = (step.verify || []).map((v) => `- \`[ ]\` ${v}`).join('\n');
      const regressions = (step.regressions || []).length
        ? '\n\n**Regressions to sanity-check:**\n\n' + step.regressions.map((r) => `- \`[ ]\` ${r}`).join('\n')
        : '';
      return `${before}${block}\n\n**Verify:**\n\n${llmVerify}${regressions}\n\n`;
    },
  );
}

function renderManualSteps(step) {
  const lines = [];
  lines.push('**Manual test:**');
  lines.push('');
  if (step.setup && step.setup.length > 0) {
    lines.push('_Setup:_');
    for (const s of (Array.isArray(step.setup) ? step.setup : [step.setup])) {
      lines.push(`- ${s}`);
    }
    lines.push('');
  }
  if (step.steps && step.steps.length > 0) {
    for (let i = 0; i < step.steps.length; i += 1) {
      lines.push(`${i + 1}. ${step.steps[i]}`);
    }
  }
  return lines.join('\n');
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function countBy(arr, fn) {
  const out = {};
  for (const x of arr) {
    const k = fn(x);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function zeroPad(n) {
  return String(n).padStart(2, '0');
}

function reflow(text, prefix = '') {
  return text.split('\n').map((l) => prefix + l).join('\n').replace(/\n\s+$/g, '');
}

function formatDuration(ms) {
  if (!ms) return '0s';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

async function readText(p) { try { return await fs.readFile(p, 'utf-8'); } catch { return null; } }

// ─── Entry point ───────────────────────────────────────────────────────────

export async function generateQaHandoff(projectName, {
  round = null,
  phaseStart = null,
  phaseEnd = null,
  withSteps: doSteps = false,
  outputPath = null,
} = {}) {
  const project = getProject(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);
  const projDir = path.join(PROJECTS_DIR, projectName);

  // Resolve scope
  let scope;
  if (round != null) {
    scope = { kind: 'round', round, label: `bug round ${round}` };
  } else if (phaseStart != null && phaseEnd != null) {
    scope = { kind: 'phases', start: phaseStart, end: phaseEnd, label: `phases ${phaseStart}–${phaseEnd}` };
  } else {
    // Default: most recent bug round
    const detected = await detectHighestBugRound(projDir);
    if (!detected) {
      // Fall back to phase range
      scope = { kind: 'phases', start: 1, end: project.total_phases || project.current_phase || 1, label: `all phases (1–${project.current_phase || project.total_phases})` };
    } else {
      scope = { kind: 'round', round: detected, label: `bug round ${detected}` };
    }
  }

  console.log(chalk.dim(`Scope: ${scope.label}`));
  const spinner = ora({ text: 'Gathering artifacts…', color: 'cyan' }).start();

  // Load bugs.md + plan
  let bugs = [];
  let fixes = [];
  let fixReports = {};
  let fixesByBug = new Map();
  let unmatchedFixes = [];

  if (scope.kind === 'round') {
    const bugsText = await readText(bugsFilePath(projDir, scope.round));
    bugs = parseBugsFile(bugsText || '');

    const planText = await readText(fixPlanJsonPath(projDir, scope.round));
    if (planText) {
      try {
        const plan = JSON.parse(planText);
        fixes = (plan.fixes || []);
      } catch { /* malformed plan */ }
    }

    // Load each fix's report
    for (const fix of fixes) {
      const fixSlug = fix.slug || (fix.title ? fix.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) : null);
      // Try common fix dir patterns
      let reportText = null;
      const candidates = [
        fixReportPath(projDir, scope.round, fix.n, fixSlug),
        path.join(bugRoundDir(projDir, scope.round), 'fixes', `${zeroPad(fix.n)}-${fixSlug || ''}`, 'report.md'),
      ];
      // Also scan the fixes dir directly
      try {
        const fixesDir = path.join(bugRoundDir(projDir, scope.round), 'fixes');
        const entries = await fs.readdir(fixesDir).catch(() => []);
        const matching = entries.find((e) => e.startsWith(zeroPad(fix.n) + '-'));
        if (matching) candidates.push(path.join(fixesDir, matching, 'report.md'));
      } catch { /* ignore */ }
      for (const c of candidates) {
        reportText = await readText(c);
        if (reportText) break;
      }
      if (reportText) fixReports[fix.n] = reportText;
    }

    const mapping = matchFixesToBugs(fixes, bugs);
    fixesByBug = mapping.byBug;
    unmatchedFixes = mapping.unmatched;
  } else {
    // Phase-range mode — simpler: read phase reports as the "fixes," no bug parsing
    const planText = await readText(planJsonPath(projDir));
    if (planText) {
      const plan = JSON.parse(planText);
      for (let n = scope.start; n <= scope.end; n += 1) {
        const phase = plan.phases?.find((p) => p.n === n);
        if (!phase) continue;
        bugs.push({
          n,
          severity: 'PHASE',
          title: phase.title || `phase ${n}`,
          repro: null,
          expected: phase.goal || null,
          acceptance: (phase.acceptance_criteria || []).join('; ') || null,
        });
        // Phase report path
        const slug = phase.slug || (phase.title ? phase.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) : '');
        const candidates = [
          phaseReportPath(projDir, n, slug),
          path.join(projDir, '.guide', 'phases', `${zeroPad(n)}-${slug}`, 'report.md'),
        ];
        try {
          const phasesDir = path.join(projDir, '.guide', 'phases');
          const entries = await fs.readdir(phasesDir).catch(() => []);
          const matching = entries.find((e) => e.startsWith(zeroPad(n) + '-'));
          if (matching) candidates.push(path.join(phasesDir, matching, 'report.md'));
        } catch { /* ignore */ }
        for (const c of candidates) {
          const rep = await readText(c);
          if (rep) { fixReports[n] = rep; break; }
        }
        fixes.push({ n, title: phase.title });
        fixesByBug.set(n, [{ n, title: phase.title }]);
      }
    }
  }

  // Gather stats
  const validators = scope.kind === 'round'
    ? getValidatorStats(projectName, { round: scope.round })
    : getValidatorStats(projectName, { phaseRange: [scope.start, scope.end] });
  const callStats = scope.kind === 'round'
    ? getCallStats(projectName, { round: scope.round })
    : getCallStats(projectName, { phaseRange: [scope.start, scope.end] });

  // Git commits since the start of this scope
  const workspaceDir = path.join(projDir, 'workspace');
  let commits = null;
  const db = getDb();
  const sinceRow = scope.kind === 'round'
    ? db.prepare(`SELECT started_at FROM bug_rounds WHERE project = ? AND round = ?`).get(projectName, scope.round)
    : null;
  const sinceISO = sinceRow ? sinceRow.started_at : null;
  if (sinceISO) commits = getGitCommits(workspaceDir, sinceISO);

  spinner.text = 'Building handoff document…';

  let markdown = await buildExtractive({
    projectName, scope, bugs, fixes, fixReports, fixesByBug, unmatchedFixes,
    validators, callStats, commits, projectMeta: project,
  });

  if (doSteps) {
    spinner.text = 'Generating manual test procedures via Opus…';
    try {
      const stepsByN = await withSteps({ projectName, bugs, fixesByBug, fixReports, projectMeta: project });
      markdown = injectStepsIntoMarkdown(markdown, stepsByN);
    } catch (err) {
      spinner.warn(chalk.yellow(`--with-steps failed: ${err.message}. Falling back to extractive output.`));
    }
  }

  // Brief conformance (phase-47): embed the matrix PROMINENTLY — right after
  // the title, before Tester info/Quick stats — since a blocked handoff means
  // QA is about to test known-incomplete work and partial FRs are exactly
  // what the tester must probe. Absent file (gate disabled, or never ran) →
  // section entirely omitted, markdown unchanged.
  const conformanceReport = await readText(briefConformanceMdPath(projDir));
  if (conformanceReport && conformanceReport.trim()) {
    const newlineIdx = markdown.indexOf('\n');
    const titleLine = newlineIdx === -1 ? markdown : markdown.slice(0, newlineIdx);
    const rest = newlineIdx === -1 ? '' : markdown.slice(newlineIdx);
    markdown = `${titleLine}\n\n---\n\n${conformanceReport.trim()}\n\n---${rest}`;
  }

  // Ship gate (phase-44): embed the deterministic scan report when it exists,
  // so the tester sees any secret/dependency/license blockers alongside the
  // bug checklist. Absent report → section entirely omitted.
  const shipGateReport = await readText(shipGateReportPath(projDir));
  if (shipGateReport && shipGateReport.trim()) {
    markdown += `\n\n---\n\n## Ship gate\n\n${shipGateReport.trim()}\n`;
  }

  // Write output
  await fs.mkdir(qaHandoffsDir(projDir), { recursive: true });
  const scopeStr = scope.kind === 'round' ? `round-${scope.round}` : `phases-${scope.start}-${scope.end}`;
  const out = outputPath || qaHandoffPath(projDir, scopeStr);
  await fs.writeFile(out, markdown, 'utf-8');

  spinner.succeed(chalk.green(`QA handoff written: ${out}`));

  // Quick stats to terminal
  console.log('');
  console.log(chalk.bold('Summary:'));
  console.log(`  Bugs:       ${bugs.length}`);
  console.log(`  Fixes:      ${fixes.length}`);
  console.log(`  Validators: ${validators.total} runs across ${Object.keys(validators.byValidator).length} validators`);
  if (callStats) console.log(`  Cost:       $${callStats.cost.toFixed(2)} across ${callStats.totalCalls} calls`);
  if (commits) console.log(`  Commits:    ${commits.length}`);
  console.log('');
  console.log(chalk.dim(`Hand this file to QA:`));
  console.log(chalk.dim(`  ${out}`));
  console.log('');

  return { outputPath: out, bugs: bugs.length, fixes: fixes.length };
}
