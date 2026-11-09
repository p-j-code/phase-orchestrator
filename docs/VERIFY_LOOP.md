# Spec: L2 Verification Loop (acceptance-check)

**Status:** IMPLEMENTED — shipped in src/lib/verify-loop.js (this doc is the spec of record; update it with behavior changes)
**Target version:** v0.15.0
**Depends on:** nothing new (reuses validator-gate + failure-routing plumbing)

---

## 1. Problem

A phase is currently marked complete when (a) the dev agent committed and (b) the
validator gate passed (`npm test` / `node --check` / configured chains,
[phase-runner.js:523-604](../src/lib/phase-runner.js)). Nothing checks the work
against the phase's **acceptance criteria** in `plan.json`. A phase can pass tests
while silently skipping half its criteria — the 3-phase review catches this late
(up to 2 phases later), at full-review cost, after the commit already pushed.

Self-review by the dev agent doesn't fix this: the session that wrote the code is
biased toward believing it works. A **fresh-context, read-only checker** is the
standard remedy (generate → verify → refine).

## 2. Design summary

After the validator gate passes and **before** `markPhaseCompleted` + `pushBranch`,
spawn a cheap, read-only `acceptance-check` call (fresh session, Sonnet) that grades
the phase's diff against `plan.json` acceptance criteria and writes a structured
verdict JSON. On `fail`: one targeted refine (resume the dev session with the
`must_fix` list injected — same shape as the validator mechanical retry), re-gate,
re-check. Still failing → phase fails through the **existing**
`routeDevFailure → escalate-to-Opus` path with the verdict riding forward as
context.

```
dev commit
   │
   ▼
validator gate (existing, unchanged) ──fail──▶ mechanical retry → fail path (existing)
   │ pass
   ▼
acceptance-check  (NEW: fresh session, read-only, sonnet)          ─┐
   │                                                                │ verify.mode:
   ├─ pass ──▶ markPhaseCompleted → push            (gate + report) │  "report" = never blocks,
   │                                                                │  verdict recorded only
   ├─ fail, refine budget left ──▶ targeted refine (resume dev     ─┘
   │        session, must_fix injected) → re-gate → re-check
   │
   └─ fail, budget exhausted ──▶ write verify content into
            validation marker → phase failed → routeDevFailure
            → Opus escalation (existing machinery, untouched)
```

**Loop contract** (per the loop-engineering rules): convergence = verdict `pass`;
budget = `max_refine_attempts` (default 2 as of phase-25) + the existing escalation
ceiling; terminal state = existing pause/escalate routing. The verdict JSON is the
loop variable — every refine sees the previous verdict, never a blind retry.

## 3. Scope

| In scope (v1) | Out of scope (v1) |
|---|---|
| `dev-execution` phases | Guide-task verification (plan-validate already exists) |
| Fixes (`fix-execution`) — checked against their round **fix-plan** entry's `acceptance_criteria`, severity-gated via `verify.include_fixes` (phase-30, §15) | New DB columns on `phases` (v2; see §10) |
| Report-only and gate modes | Multi-verifier voting panels for **fixes** (phase-29's adversarial panel stays phases-only; fixes always use the single checker) |
| Verdict on disk + calls-table row | — |
| One refine attempt | — |

## 4. Config

### 4.1 `config/defaults.json` (bump `$schema_version` 4 → 5)

New keys only, all with defaults — existing project overrides are unaffected
(no migration logic needed; note the bump in CHANGELOG).

> **phase-25 update:** `mode` now ships as `"gate"` and `max_refine_attempts` as
> `2` (see below). `"report"` is retained as the per-project **shadow opt-out**
> (`overrides.verify.mode: "report"` restores the pre-phase-25 record-only
> behavior exactly). The block as shipped today:

```jsonc
"verify": {
  "enabled": true,
  "mode": "gate",
  "_mode_comment": "phase-25: 'gate' is the DEFAULT for EVERY project — a fail verdict triggers the bounded refine → escalation ladder before the phase can complete/push. 'report' = shadow mode (record only, never block) — opt back in per-project via overrides.verify.mode. 'off' = skip the checker.",
  "max_refine_attempts": 2,
  "_refine_comment": "Targeted refine calls (resume the SAME dev session with must_fix injected). Attempt 1 runs on the dev model; attempt 2+ bumps the model ONE tier up (sonnet→opus→fable; fable dev model = no bump). Tiers tried ride onto verify_outcome.refine_tiers so the escalation marker targets a rung above everything already burned.",
  "skip_when_no_criteria": true,
  "_skip_comment": "Phase has no acceptance_criteria in plan.json → skip the checker (goal-only phases are graded by the 3-phase review instead).",
  "fail_open": true,
  "_fail_open_comment": "Checker infrastructure failure (spawn error, missing/invalid verdict JSON after 1 re-ask) does NOT block the phase; logs a warning and records verdict='inconclusive'. Set false to fail-closed.",
  "include_fixes": "major+",
  "_include_fixes_comment": "phase-30: three-valued — false (never verify fixes) | true (verify every fix) | 'major+' (DEFAULT — verify only critical/major fixes; a missing severity counts as major). Schema mirror uses oneOf so a legacy boolean override still validates and keeps its old meaning. See §15.",
  "cadence": {
    "mode": "every-phase",
    "every_n_phases": 3,
    "always_final": true,
    "always_complexities": ["high", "critical"],
    "always_checkpoints": ["architecture", "schema", "external-integration", "destructive"]
  }
},
"models": {
  // add:
  "acceptance-check": "claude-sonnet-5"
},
"phases": {
  // add — generalizes the existing per-task wall-clock override pattern:
  "task_max_turns": { "acceptance-check": 20 },
  "task_timeout_ms": { "fix-execution": 600000, "acceptance-check": 480000 }
}
```

`cadence.mode: "checkpoints"` is an opt-in throughput mode. It never changes
the deterministic validator gate, never changes fix verification, and always
runs the checker when phase position is unavailable (fail-safe). The bundled
`development-focused` profile enables it; the defaults remain `every-phase`.

Also update `config/schemas/defaults.schema.json`, and run `npm run test:config`
(there is a task-coverage test — `config-task-coverage.test.mjs` — that will need
the new task name registered).

### 4.2 Model routing

`acceptance-check` is **not** added to `escalation_tasks` (checking doesn't get
harder when implementing did) and gets no hard floor. It routes on the baseline
model only. Do not let the phase's Opus escalation marker touch the checker —
verification stays cheap even when implementation escalated.

## 5. The checker call

**Call site:** [phase-runner.js](../src/lib/phase-runner.js) `runDev()`, immediately
after the validator-gate block ends (`commit_sha = await getHeadSha(...)`, ~line 603)
and before `markPhaseCompleted` (~line 606). Push happens after — a failing phase
never lands on origin, same guarantee as the gate.

**Invocation (via `runClaude`, no new spawn path):**

```js
const verifyRes = await runClaude({
  cfg: verifyCfg,                    // cfg clone: model from models['acceptance-check']
  cwd: workspaceDir,
  prompt: checkerPrompt,             // §6
  systemPromptFile: null,            // no dev-system.md — checker is not a dev
  systemPromptExtra: CHECKER_SYSTEM, // short static block, byte-identical across calls (cache-friendly)
  sessionId: null,                   // ALWAYS fresh context — never resume
  role: null,                        // ⚠ not 'guide'/'dev': runClaude would clobber
                                     //   guide_session_id / last_dev_session_id
                                     //   (claude-runner.js:457-461). role:null skips
                                     //   session bookkeeping; the calls row still
                                     //   records project/phase/task/cost (v0.14.16
                                     //   precedent for roleless calls).
  project: projectName,
  phase: nextPhase,
  task: 'acceptance-check',
});
```

**Tool sandbox.** The checker must not be able to mutate the workspace. Override
allowed tools for this call (plumb through `cfg.tools.allowed_default` on the cfg
clone):

```
Read, Glob, Grep
```

No `Write`, no `Edit`, and no `Bash`. Before the spawn, the orchestrator runs
array-argument `git diff` locally and compiles one bounded evidence bundle: at
most 96,000 patch characters (EVIDENCE_DIFF_MAX_CHARS in verify-loop.js — the constant is authoritative), 8,000 report characters, 200 changed paths, and
the deterministic validator names/scope/pass/duration summary.
The checker starts from that bundle and uses read/search tools only for a
specific criterion evidence gap. This removes denied shell attempts and repeat
repository rediscovery from the token-bearing session.

## 6. Checker prompt

Built by a new module `src/lib/verify-loop.js` → `buildAcceptanceCheckPrompt()`.
Inputs it already has at the call site: `phaseMeta` (goal, acceptance_criteria,
files_expected), `preSha`, `commit_sha`, `changedFilesSince(workspaceDir, preSha)`
(already computed for the gate), the dev report path, and the verdict output path.

Template (volatile values at the end where possible; the static instruction block
stays byte-identical for prompt-cache reuse):

```markdown
You are an acceptance checker. You did NOT write this code. Your job is to verify —
strictly and with evidence — whether the phase's acceptance criteria are actually
met by the code as committed. You are read-only: do not fix, edit, or improve
anything. Judging is your only output.

Rules:
- For each criterion, find concrete evidence in the CODE (file + line). The dev's
  report at {relReportPath} is a claim, not evidence — read it, then verify against
  the code. A criterion the report says is done but the code doesn't show is "unmet".
- "unverifiable" is allowed (e.g. needs a live external service) — say why. It does
  not fail the phase, but never use it to dodge a checkable criterion.
- Start from the bounded committed patch/report evidence bundle assembled by
  the orchestrator. Do NOT run git, tests, or builds — the validator gate already
  ran. Use Read/Glob/Grep only to fill a specific evidence gap.

Phase {n}: {title}
Goal: {goal}

Acceptance criteria (verbatim from plan.json):
{numbered criteria}

Files expected by the plan: {files_expected}
Files actually changed: {changedFiles}

You have no Write, Edit, or Bash tool — you cannot write any file yourself.
Your final reply must contain EXACTLY one JSON object matching the schema in §7
and nothing else (no markdown fence, no prose, no "done"). The orchestrator
parses that reply and persists the verdict to verify.json itself.
```

**Verdict path:** new helper in [guide-paths.js](../src/lib/guide-paths.js) —
`phaseVerifyPath(projectDir, n, fallbackTitle)` → `.guide/phases/NN-slug/verify.json`
(sits next to `report.md`, follows `phaseReportPath`'s pattern including
`findPhaseDir` reuse).

## 7. Verdict schema

Validated with `ajv` (already a dependency) in `verify-loop.js`. Stored verbatim on
disk; the orchestrator's decision derives from it.

```jsonc
{
  "$schema_version": 1,
  "phase": 3,
  "verdict": "pass",                    // "pass" | "fail"
  "criteria": [
    {
      "criterion": "verbatim text from plan.json",
      "status": "met",                  // "met" | "unmet" | "unverifiable"
      "evidence": "src/api/tds.js:142 — validateFVU() rejects malformed 26Q rows; covered by the diff"
    }
  ],
  "must_fix": [                          // required when verdict = "fail"; ordered, specific, actionable
    "Criterion 2: plan requires rate-limit headers on /export — no header written anywhere in the diff (checked src/routes/export.js)"
  ],
  "notes": "optional free text"
}
```

**Decision rule (orchestrator-side, deterministic — don't trust `verdict` alone):**

```
effective_fail = (verdict === "fail") OR (any criterion.status === "unmet")
```

`unverifiable` never fails a phase but is surfaced in the log line and notifier
message. Missing/unparseable verdict file: re-ask once by resuming the checker
session with the ajv errors ("your verdict JSON was invalid: … — rewrite it to the
exact schema"); still bad → `inconclusive` → honor `verify.fail_open`.

## 8. Refine step (on effective fail, mode = "gate")

Mirrors the validator mechanical retry ([phase-runner.js:544-593](../src/lib/phase-runner.js))
— resume the **dev** session, inject the verdict:

```
Your commit for phase {n} passed the validators but FAILED acceptance verification
by an independent reviewer. Unmet criteria:

{must_fix list}

Fix EXACTLY these items — nothing else. No refactors, no scope creep. When fixed,
make one commit (same message format, suffixed "(acceptance fix)").
```

Then: re-run the validator gate on the new diff (cheap, local) → re-run the checker
(fresh session again). Loop bounded by `verify.max_refine_attempts` (default 2).

**phase-25 tier-escalating rung.** Attempt 1 resumes the dev session on the current
dev model (unchanged from today). Attempt 2+ resumes the **same** session — the
loaded context is the asset, so we keep it and only add horsepower — but bumps the
model **one tier above the dev model** (`sonnet→opus→fable`) via `modelToTier` +
`nextTier` (an already-`fable` dev model has no rung above it → no bump). The bumped
`{...cfg, model}` is passed only to the refine dev call; the validator gate and the
read-only checker keep the original `cfg` (the checker still resolves its own model
from `models['acceptance-check']`). Cross-model `--resume` is supported and
`claude-runner`'s thinking-block-400 retry already covers the corrupt-resume edge —
no new resume handling is added. The tiers actually tried are returned as
`outcome.refine_tiers` (e.g. `['sonnet','opus']`).

**Budget exhausted →** fail the phase through the existing machinery:

1. Append the verify failure to the **existing** `validationMarkerPath`
   (`phase-N-validation-failed.marker`) under a heading:
   `## Acceptance verification failed\n{must_fix as bullets}`.
   Reusing this marker (rather than a new one) buys, with zero new code: the
   commit-reconcile shortcut refuses to resurrect the failing commit
   (phase-runner.js:492), and the next attempt's prompt gets the failure as
   forward-fix context (phase-runner.js:384). The marker is already cleared on
   gate pass — acceptable, since a re-run's verify still re-checks.
2. Return `is_error: true` with
   `error_message: "Phase {n} committed but failed acceptance verification (after {k} refine attempt(s)): {must_fix summary}"`
   and `verify_outcome` attached (parallel to `validator_outcome`).
3. `upsertPhase(status: 'failed')`, commit stays local, no push — identical to the
   gate-failure return shape (phase-runner.js:582-591).

`routeDevFailure` ([auto-runner.js:125](../src/auto-runner.js)) then routes it:
non-transient, non-timeout → `escalate` → Opus re-run with the marker present.
**No changes to auto-runner routing are needed.** One change to
[error-classifier.js](../src/lib/error-classifier.js): add
`/failed acceptance verification/i` to the `validation` kind patterns so the healer
never misroutes it as `orchestrator-bug`.

## 9. Mode = "report" (shadow opt-out; **no longer the default** as of phase-25)

The shadow window closed: `mode` now defaults to `"gate"` for **every** project
(§4.1). `"report"` remains as the per-project opt-out — set
`overrides.verify.mode: "report"` in a project's `project.json` to restore this
record-only behavior *exactly*: everything in §5-§7 runs; §8 does not. On effective
fail: log `⚠ Phase N: acceptance verify FAILED (report-only) — 2/5 criteria unmet`,
include the verdict in the notifier message, record the calls row, keep `verify.json`
on disk — then complete and push as today. Mode isolation is structural
(`shouldRunGateRefine` returns `false` for any non-`gate` mode), so a project pinned
to `"report"` is provably unaffected by the gate-mode ladder above.

### 9.1 Async report mode (phase-51 / par-02)

Report mode's verdict never blocks completion — yet before phase-51 the checker
still ran **inline**, before `markPhaseCompleted`/`pushBranch`, serializing a
2-5 min read-only Sonnet call into every phase's critical path (~1.5-3 h on a
40-phase run for a verdict that only ever gets logged). `verify.async_report`
(default **`true`**, §4.1) moves that call **off** the critical path.

This is the one config key that defaults to a *new* behavior rather than the
prior one (advisory-only, so read-side back-compat is preserved regardless — the
brief NFR names it and `audit.scan_shards` as the two documented exceptions).
It has **no effect** outside report mode: gate mode is always synchronous (a
failing gate verdict blocks completion, which a deferred check structurally
cannot do), and fixes never defer.

**Flow (report + `async_report` + a caller that opts in via `deferVerify`):**

1. **`runDev({ ..., deferVerify: true })`** — `shouldDeferAcceptanceCheck`
   (phase-runner.js) gates on `!fix && deferVerify && mode==='report' &&
   async_report===true && shouldRunAcceptanceCheck(...).run`. Deferral is a
   *when* change, never a *whether* change: a phase the checker would have
   skipped anyway (no criteria, `mode:'off'`, …) is never deferred — it skips
   exactly as before. When it fires, `runDev` **skips the inline check and the
   report-mode lesson call**, completes + pushes immediately, and attaches
   `result.deferred_verify = { phaseN, phaseMeta, preSha, commitSha }`. No spawn
   happens inside `runDev` — so no `acceptance-check` calls row exists at return.
   Every other combination (gate mode, `async_report:false`, a fix, or a CLI
   caller that omits `deferVerify`) is byte-for-byte the pre-phase-51 inline path.

2. **`runDetachedAcceptanceCheck({ cfg, projectName, projDir, workspaceDir, job })`**
   (verify-loop.js) — runs the **same** `runAcceptanceCheck` (§5), but against a
   detached git **worktree** pinned to `job.commitSha` (phase-50's
   `addDetachedWorktree`, under `worktreesRoot(projDir)/verify-<sha8>`). The
   worktree's HEAD **equals** `commitSha`, so `changedFilesSince(preSha..HEAD)`
   resolves exactly as it would have inline even though the live workspace has
   moved on to phase N+1. The verdict persists to the **absolute**
   `phaseVerifyPath(projDir, …)` (derived from `projDir`, never the worktree) —
   the read-only checker sandbox has no Write tool, so the orchestrator writes it
   exactly as today. The worktree is removed in a `finally` (runs even when the
   check itself rejects).

3. **`src/auto-runner.js`** — dev actions pass `deferVerify: true`. A successful
   dev result carrying `deferred_verify` holds **one** `pendingVerify` slot
   `{ promise, phaseN, label }` (cap 1 outstanding — the previous slot is awaited
   before the next fires). On settle: the **identical** `formatVerifyOutcomeLine`
   line (label `Phase N`, byte-for-byte the inline wording — e.g.
   `⚠ Phase N: acceptance verify FAILED (report-only) — 2/5 criteria unmet`),
   the **same** `maybeRecordReportModeVerifyFailLesson` lesson an inline fail
   would record, then a follow-up notifier line (the verdict genuinely arrives
   after the phase-completion ping, so it is its own notification).

**Barriers (bounded-concurrency NFR — `allSettled` semantics, a rejected check
never crashes the loop):** the `pendingVerify` promise never rejects (its own
`.then/.catch` degrades advisory-only on any failure). The auto-runner
settle-**awaits** it before executing **any** guide action (review/audit/bug-plan
all read `verify.json` + lessons the background checker may still be writing) and
inside **`finalize()`** on every terminal path, so an auto-run never exits with
an orphaned spawn. Cache discipline is untouched: only *when* the checker runs
changes — its prompt (§6) is byte-identical.

## 10. Observability

- **v1:** the `calls` table already captures cost/tokens/duration per
  `acceptance-check` row (nothing to add); `verify.json` on disk is the verdict
  record; `/spend` and the web-ui call table pick the task up automatically.
- **v2 (separate change):** `ALTER TABLE phases ADD COLUMN verify_status TEXT` /
  `verify_unmet INTEGER` via a `migrate-verify.js` (idempotent, follows
  `migrate-total-phases.js`), so the web-ui phase table can show verdicts without
  disk reads.

## 11. Cost / window impact

Per phase: **one** fresh Sonnet call, ≤20 turns, read-only (no test runs — the
expensive part of dev turns). Expect roughly 5-10% of a dev-execution's window
weight. Refine calls only occur on genuine fails, and each refine replaces what
today is a *far more expensive* outcome: a bad phase surviving until the 3-phase
review or an audit round, then a fix round (guide bug-plan + fix-execution + its
own gate). Net window effect is expected neutral-to-positive; the shadow window
(§9) verifies this with real numbers via `/spend`.

## 12. Files changed

| File | Change |
|---|---|
| `config/defaults.json` | `verify` block; `models["acceptance-check"]`; `phases.task_max_turns`; `task_timeout_ms["acceptance-check"]`; bump `$schema_version` → 5 |
| `config/schemas/defaults.schema.json` | schema for the new keys |
| `src/lib/verify-loop.js` | **new** — `buildAcceptanceCheckPrompt`, `parseVerdict` (ajv + one re-ask), `decideVerdict`, `runAcceptanceCheck` orchestration incl. refine loop |
| `src/lib/phase-runner.js` | `runDev()`: insert verify block after gate / before `markPhaseCompleted`; append-to-marker on terminal fail; attach `verify_outcome` to result |
| `src/lib/guide-paths.js` | `phaseVerifyPath()` |
| `src/claude-runner.js` | honor `cfg.phases.task_max_turns[task]` (3-line addition next to the existing `opusCap` logic, claude-runner.js:224-227) |
| `src/lib/error-classifier.js` | `/failed acceptance verification/i` → `validation` kind |
| `src/lib/verify-loop.test.mjs` | **new** — unit tests: decision rule (pass / fail / unverifiable-only / verdict-says-pass-but-criterion-unmet), ajv rejection + re-ask, fail_open path, marker append format |
| `scripts/verify-v0_15_0.mjs` | **new** — integration harness per repo convention: fake checker via `__testHooks`, assert report-mode never blocks, gate-mode routes to escalation, marker content, no `setLastDevSessionId` clobber |
| `docs/ARCHITECTURE.md` | new module + updated phase-completion sequence |
| `docs/AUTO_RUN.md` | verify step in the run loop description |
| `src/config-task-coverage.test.mjs` | register `acceptance-check` |

Post-change: `npm run test:config` (per CLAUDE.md).

## 13. Invariants (must hold; encode in tests)

1. **Checker can never mutate the workspace** — tool allowlist has no Write/Edit,
   Bash restricted to `git diff/log/show`.
2. **Checker never clobbers session state** — `role: null`; `guide_session_id` and
   `last_dev_session_id` unchanged after a check (regression test).
3. **A verify-failed phase never pushes** — same guarantee as the gate.
4. **Report mode is provably non-blocking** — with `mode: "report"`, `runDev`'s
   return value is byte-identical to today's on the success path (plus the
   `verify_outcome` field).
5. **No new loop can run unbounded** — refine bounded by `max_refine_attempts`;
   escalation bounded by existing `escalateRetryDone` set; checker re-ask bounded
   to 1.
6. **Opus escalation of the phase does not escalate the checker** — routing
   independence (§4.2).

## 14. Open decisions (confirm before implementing)

1. **Refine budget** — spec says 1. Bump to 2 for projects with long criteria lists?
   (Config-overridable per project either way: `overrides.verify.max_refine_attempts`.)
2. **Reviews interplay** — once gate mode is stable, consider raising
   `review_every_n_phases` 3 → 5 (per-phase verification reduces what mid-stream
   reviews exist to catch). Defer until shadow data exists.
3. **Haiku for the checker?** After the shadow window, trial
   `models["acceptance-check"]: "claude-haiku-4-5"` on low-stakes projects and
   compare verdict agreement vs Sonnet. Not the v1 default — checker quality is the
   product here.

## 15. Fix acceptance-checking (phase-30)

Fixes (`fix-execution`) now feed the **same** gate/refine/escalation loop as phases.
Previously `verify.include_fixes` was a `false` facade — flipping it wasn't enough
because `runAcceptanceCheck` hard-coded phase-shaped paths (`phaseReportPath` /
`phaseVerifyPath`, keyed on `nextPhase`, which is `null` for a fix) and
`guide-paths.js` had no fix verdict-path helper. Phase-30 adds the plumbing.

### 15.1 Three-value `include_fixes` (default `'major+'`)

`verify.include_fixes` is now `false | true | 'major+'`, **default `'major+'`**.

| Value | Behavior |
|---|---|
| `false` | Never verify fixes (pre-phase-30 behavior). |
| `true` | Verify every fix (subject only to the criteria check below). |
| `'major+'` (default) | Verify only fixes whose severity is `critical`/`major`; **skip `minor`**. A missing/unrecognized severity counts as **major** (verify it, don't skip). |

**Changing the default from `false` to `'major+'` turns fix-checking ON for every
project** — the intended rollout, not an accident. Independent of this setting, a
fix entry with **no `acceptance_criteria`** always skips with a dim log.

**Back-compat is mandatory and structural.** The schema mirror uses `oneOf`
(`{type:"boolean"}` | `{const:"major+"}`), so a project/user layer still carrying
`include_fixes: true|false` validates and resolves with its *old* semantics —
config-resolver's `deepMerge` just overwrites the key (no migration, no
`$schema_version` bump). `overrides.verify.mode: "report"` still restores the
record-only behavior for fixes exactly as for phases.

The run/skip decision lives in the **pure** `shouldRunAcceptanceCheck({ verifyCfg,
fix, hasCriteria, severity })` (phase-runner.js) — three-value logic + the criteria
check, no I/O.

### 15.2 Resolving a fix's criteria

A fix has no `plan.json` phase entry; its criteria live in the round's **fix-plan**
at `.guide/bug-rounds/round-R/plan.json`, whose `fixes[]` entries carry
`{ n, title, bugs_addressed, goal, severity, acceptance_criteria, files_likely }`
(prompts/guide-system.md §6). `buildAcceptanceCheckPrompt` is **pure over the phase
shape** (`{n, title, goal, acceptance_criteria, files_expected}`), so
`verify-loop.js` maps the fix entry into that shape in one place —
`mapFixEntryToPhaseMeta(fix, entry)` — mapping **`files_likely` → `files_expected`**
and carrying `severity` along for the gate above. `resolveFixPhaseMeta(projDir, fix)`
is the I/O wrapper (reads the round plan, finds `fix.n`'s entry). It is **fail-open**:
a missing/unreadable round plan or a `fix.n` with no matching entry resolves to
`null`, and the caller then defaults `hasCriteria` to `true` so an infra hiccup
never silently skips verification. This is distinct from an entry that *was* found
but has a genuinely empty `acceptance_criteria` list — that one skips.

### 15.3 Path routing

`runAcceptanceCheck` (and its `runCheckerCore`) take an optional
`fix: { round, n, title }`. When present, report/verdict paths route through the
fix dir instead of the phase dir:

- `fixReportPath(projectDir, round, n, fallbackTitle)` → `.guide/bug-rounds/round-R/fixes/NN-slug/report.md`
- `fixVerifyPath(projectDir, round, n, fallbackTitle)` → `.guide/bug-rounds/round-R/fixes/NN-slug/verify.json` **(new, phase-30)** — sibling to `fixReportPath`, reusing `fixDir` so both always resolve to the same `NN-slug` directory.

`preSha`/`commitSha` plumbing is identical to phases. The call site
(`runPhaseAcceptanceCheck`) already had `fix` in scope and threads it through;
`runAcceptanceGateLoop`'s internal refine re-checks thread the same `fix` object,
so every checker call — initial and refine — resolves the same fix dir and meta.

### 15.4 Gate + escalation reuse (no new loop)

The gate-refine-for-fixes path needed **no new code**: `runAcceptanceGateLoop`
already accepts fix plumbing (the `gateEvent` fix branch), and phase-25 turned the
gate on. So a failing fix verdict enters the tier-laddered refine (`sonnet→opus→fable`,
bounded by `max_refine_attempts`), and exhaustion writes the **fix-shaped** phase-23
escalation marker (`.guide/fix-rR-N-escalate.marker`) — asserted end-to-end in
`verify-gate-mode.test.mjs`, not re-implemented.

### 15.5 Panel stays phases-only

The phase-29 adversarial dual-checker panel is **never** routed for a fix —
`shouldRunAcceptancePanel` returns `false` unconditionally when `fix != null`.
Fixes always use the single checker.
