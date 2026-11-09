# Changelog

## [0.14.48] — 2026-06-14 — incremental audits can no longer go blind

### Fixed

- **Incremental audits now force a full re-scan when they'd otherwise see
  nothing.** Since v0.14.34 each audit after the first scopes to the git diff
  since the last audit's SHA. But if HEAD hasn't moved, the diff is empty and
  the audit looks at nothing — so a latent issue in untouched code stays
  invisible indefinitely (observed on asp: six consecutive audits against the
  same HEAD `a2ee7747`, each finding nothing, which read as "the code is
  clean" when it was really "the audit stopped looking"). `detectIncrementalAudit`
  now forces a full audit when (a) HEAD equals the last audited SHA, or (b) the
  project has had `audit.force_full_every_n` consecutive incrementals (default
  5). The marker tracks an `incremental_streak` — incremented after an
  incremental audit, reset to 0 after any full audit. `force_full_every_n: 0`
  disables the periodic full but the unchanged-HEAD full always applies.
  *(phase-runner.js — detectIncrementalAudit + new stampLastAudit helper used
  by both stamp sites; config/defaults.json)*

> If asp (or any project) has been auditing clean against an unchanged HEAD,
> the very next audit after this upgrade will be a full re-scan — expect it to
> surface anything the incrementals were skipping, or confirm the tree is
> genuinely clean.

### Verify

- `scripts/verify-v0_14_48.mjs` — 8 checks: functional unchanged-HEAD →full,
  changed+under-threshold →incremental, streak≥N →full, every_n:0 disables
  periodic, default threshold 5, streak increment/reset wiring, cfg threaded
  at both call sites, defaults+version.
- verify-v0_14_36.mjs re-pinned: two assertions updated to the post-.41
  (ensureValidPlan) and post-.48 (auditWasIncremental branch) shapes.

## [0.14.47] — 2026-06-14 — docs catch-up (NEW_FEATURES / TELEGRAM_BOT / MODEL_ROUTING)

> Docs-only. No runtime code touched; unit suite unchanged.

### Docs

- **NEW_FEATURES.md** — added the v0.14.34→.46 cost/quality arc: `/spend`,
  severity-gated promote, incremental + two-stage audits, validator gate,
  inline prompts, failure-driven + scoped escalation, plan validation,
  self-healing night runs, ♾ until-clean, manual-round drain, deferred
  transient retries, `/addbug`, QA-pending clean message. Was 31 releases
  behind (stopped at v0.14.15).
- **TELEGRAM_BOT.md** — bumped to v0.14.46; documented `/spend` and `/addbug`
  in their command tables and the Audit button menu (Audit-only / Auto ×N /
  ♾ Until clean) in the inline-buttons section. Was at v0.14.32.
- **MODEL_ROUTING.md** — corrected stale claims: Haiku fully retired,
  `prefer_top_for_critical` retired (false) and replaced by failure-driven
  escalation, added the `escalation_tasks` scope and two-stage `audit-scan`
  tier; fixed the config example and troubleshooting entries that still
  referenced `never_use_haiku_*` and complexity escalation.
- Verified with an actual `vitepress build docs` (all pages render) plus a
  bare-`<tag>` Vue-hazard scan — no `&lt;placeholder&gt;`-style component
  crashes.

### Verify

- `scripts/verify-v0_14_47.mjs` — 6 checks: each doc covers its new surface,
  stale claims removed, Vue-hazard scan clean, version.

## [0.14.46] — 2026-06-14 — clean-audit message surfaces a QA-pending round

### Changed

- **A clean audit now names the round waiting on you.** When an audit chain
  ends clean but the most recent fix round is `completed` and the working
  branch is still ahead of main (fixed, not yet shipped), the ✅ message
  appends "→ bugs round N is fixed and awaiting your re-test — then /ship".
  Previously the chain went silent about the one thing needing the operator
  after a successful unattended fix (observed on asp round 5: the fix landed,
  the chain re-audited clean, but nothing pointed at the pending re-test).
  Best-effort and additive — never blocks or alters the terminal state.
  *(server/job-runner.js)*

### Verify

- `scripts/verify-v0_14_46.mjs` — 4 checks: completed+unshipped detection,
  note gating, append wiring, version.

## [0.14.45] — 2026-06-12 — /addbug: manual bug rounds in the right place, every time

> Root-causes the asp episode: a hand-typed heredoc landed in the wrong cwd, so
> round-4 was never on disk — audits stayed correctly clean and `go` had
> nothing to pick up, but it looked like a stuck orchestrator for a day.
> Removes the manual-path failure mode instead of asking the operator to be
> more careful.

### Added

- **`/addbug <project> <title>` (aliases /add_bug, /newbug).** The orchestrator
  computes the next round number (`detectHighestBugRound + 1`), creates
  `projects/<p>/.guide/bug-rounds/round-N/`, and writes a bugs.md with a
  canonical `### Bug #1` skeleton (Steps/Expected/Actual/Affected files, title
  prefilled) — at the exact path the picker reads. Refuses to clobber an
  existing round's bugs.md. Returns a "▶ Run fixes (round N)" button wired to
  `go`. No DB writes. There is no longer any reason to hand-create a round
  with a shell heredoc. Registered but kept out of the 25-entry command menu
  (reachable by the button and by typing), like /budget. *(telegram-parity-handlers.js,
  server.js)*
- **Project card flags a dropped-but-unrun round.** If a round's bugs.md
  exists on disk with no fix-plan.json yet (a manually created/dropped round
  awaiting `go`), the card now shows "🐞 bugs round N is on disk but not yet
  run — tap ▶ Go". The safety net: even a round created out-of-band can no
  longer hide behind repeated clean audits. *(telegram-handlers.js)*

### Verify

- `scripts/verify-v0_14_45.mjs` — 7 checks incl. functional next-round path
  computation (lands under round-N+1) and the card's bugs.md-without-plan
  detection.

## [0.14.44] — 2026-06-12 — deferred transient retries: external failures re-run themselves

### Added

- **External/API failures now reschedule themselves — recursively, until the
  world recovers.** New transient classifier (`src/lib/transient-errors.js`):
  rate limits, overload (429/529), 5xx, network drops, billing windows are
  "weather" — the code is fine, the world broke. When a job FAILS with a
  transient reason, or an auto-run PAUSES on one, the identical job is
  re-enqueued with `not_before = now + transient_retry_minutes` (default 60)
  and `retry_count + 1`, with a "⏳ auto-retry #N scheduled in 60m" Telegram
  note. State-driven actions (go / resume / audit chains) re-enter exactly
  where they left off. `transient_retry_max` 0 = unlimited (default);
  `retry_transient:false` disables. DB-backed (`tg_jobs.not_before`,
  additive migration), so scheduled retries survive server restarts.
  Sleeping retries are invisible to the picker AND excluded from the
  per-project FIFO blocker — a 60-minute wait never blocks jobs you queue
  manually behind it. Auth/key errors are deliberately NOT transient (need a
  human); validator/no-commit/plan failures are code problems and keep their
  existing flows; the auto-runner skips both the Opus retry and skip-parking
  on transient errors (neither helps against weather). *(transient-errors.js,
  state.js, server/job-queue.js, server/job-runner.js, auto-runner.js,
  defaults.json)*

### Verify

- `scripts/verify-v0_14_44.mjs` — 9 checks: functional classifier (incl. the
  "validators failed: 500 expectations" trap staying non-transient), schema,
  picker invisibility on both clauses, both scheduling hooks, auto-runner
  gating, defaults.

## [0.14.43] — 2026-06-12 — hardcore mode: ♾ until-clean chains, park-on-double-failure

### Added

- **♾ Until clean** in the Audit menu (and `--rounds=inf` on /run): the
  audit→fix chain loops until an audit comes back clean (with no pending
  manual round), instead of a fixed ×N. Stops remain: clean (success), audit
  failure, blocker, and a safety ceiling `auto_run.max_chain_rounds`
  (default 25) against pathological audit↔fix oscillation. Progress and
  summaries render ∞. *(telegram-handlers.js, job-runner.js, defaults.json)*
- **`auto_run.on_double_failure: "skip"` (opt-in; default "pause").** When
  Sonnet AND the in-run Opus retry both fail the same FIX, skip mode parks it
  — logged to the round's `parked.md` with the failure excerpt, the round
  advances to the next fix, a Telegram note fires — instead of pausing the
  whole run. The bugs.md entry remains and the post-round audit re-surfaces
  the underlying bug, so parked work cannot silently vanish. Phases are
  NEVER skipped: phase N+1 builds on N; skipping would compound the failure.
  *(auto-runner.js, defaults.json)*

### Verify

- `scripts/verify-v0_14_43.mjs` — 8 checks: inf plumbing end to end
  (button → handler → job args → loop ceiling → ∞ rendering), skip-mode
  park/advance/notify wiring, fix-only gating, defaults.

## [0.14.42] — 2026-06-11 — audit chains drain pending manual bugs rounds

### Changed

- **A clean audit no longer ends the ×N chain past a manually dropped bugs
  round.** The Audit ×1/×3/×5 flow was audit-scoped: clean audit → ✅ done —
  even when the operator had hand-dropped
  `.guide/bug-rounds/round-N/bugs.md` expecting the button to fix it
  (observed live on asp, three runs in a row). Both chain drivers now check
  `detectNewBugRound` at the clean-audit branch: pending round on disk →
  notify ("Audit clean, but pending manual bugs round N detected — running
  fixes…") → drain it via unattended autoRun (bug-plan generates
  fix-plan.json when only bugs.md exists, then every fix runs through the
  validator gate) → `continue`, so the next loop iteration re-audits the
  manual fixes, budget permitting. A drain that hits a blocker surfaces it
  exactly like an audit-promoted round. No pending round → the ✅ clean
  terminal state, unchanged. `detectNewBugRound` is now exported from
  auto-runner. *(server/job-runner.js, orchestrator.js — CLI parity,
  auto-runner.js)*

### Verify

- `scripts/verify-v0_14_42.mjs` — 6 checks incl. functional
  detectNewBugRound on a hand-dropped bugs.md (→ `{round, needsPlan:true}`)
  and drain-before-✅ ordering in both drivers.

## [0.14.41] — 2026-06-11 — brief-flow audit: pipeline brief/plan results checked, structural gate shared

> Brief flows traced end to end: all four pickNextAction gates (missing/empty
> brief, [NEEDS USER INPUT], brief-questions, inputs-newer staleness), the
> --auto-brief review gate, brief snapshots, and the .36 regen scope all check
> out. Two defects found in pipeline.js — both one-line `try { await
> runGuide(…) }` forms that dodged the .40 fire-and-forget sweep.

### Fixed

- **Pipeline brief-author result checked.** A failed brief-author RESULT fell
  through; the review gate then said "review .guide/brief.md" for a file that
  was never written, or --auto-brief runs died downstream on the missing-brief
  gate with the wrong reason. Now stops at the brief stage with
  `brief-author failed: <reason>`. *(pipeline.js)*
- **Pipeline plan path: result checked AND the structural gate now applies.**
  The pipeline's pre-plan call bypassed executeAction, which is where the
  v0.14.36 structural validation + auto-regen lived — pipeline-built plans got
  NO validation at all. The gate is extracted to an exported
  `ensureValidPlan({projectName, projDir, brief?, slot?})` (auto-runner.js),
  used by executeAction and pipeline alike: missing/unparseable plan → honest
  error; structural problems → one regen via plan-fix.hint → re-validate →
  stop with the problem list. *(auto-runner.js, pipeline.js)*
- **The .40 verifier sweep is hardened** to also catch one-line
  `try { await runGuide(` forms — the pattern both of these hid behind.
  *(scripts/verify-v0_14_40.mjs)*

### Verify

- `scripts/verify-v0_14_41.mjs` — 6 checks incl. functional ensureValidPlan
  (missing-plan and valid-plan paths) and the hardened zero-fire-and-forget
  sweep across all three drivers.

## [0.14.40] — 2026-06-11 — flow audit: predict matches reality, every guide job fails honestly

> Full static trace of all operational flows on the .39 tree (phase, fix,
> audit ×N, pipeline, plan regen, markers/hints/sentinels, pause classifier).
> Marker lifecycles all check out (writer + reader + cleaner); the pause
> classifier covers every current reason string. Three defect groups found
> and fixed below.

### Fixed

- **`/predict` (alias `/cost`) no longer prices calls that don't run.** It
  unconditionally added a `phase-prompt-gen` unit per phase and a
  `fix-prompt-gen` unit per fix — both eliminated by default in v0.14.35/37.
  Prediction units now mirror the runtime exactly: prompt-gen priced only
  when the corresponding `inline_*_prompts` flag is explicitly false.
  *(commands/predict.js)*
- **CLI audit ×N chain gets the .39 fix.** `npm run audit -- --auto/--chain`
  had the identical swallow as the server chain: failed audits fell through
  to promote and died on the sentinel as "duplicate". Initial audit failure
  now exits with the real reason; mid-chain failure stops with
  `audit failed on round N: …`. *(orchestrator.js)*
- **Single-task guide jobs no longer report ✓ on failure.** roadmap,
  brief-author, review, handoff, and the generic guide-task job in
  job-runner all ignored the result — a failed guide run produced
  "✓ Completed" with no artifact. All five now throw with the guide's
  error, so the job notification reads ✗ with the reason. The CLI handoff
  path fails likewise; CLI workspace-claude-md warns (genuinely optional).
  Zero fire-and-forget `runGuide` calls remain in job-runner, orchestrator,
  or pipeline. *(server/job-runner.js, orchestrator.js)*

### Verify

- `scripts/verify-v0_14_40.mjs` — 8 checks incl. a structural "no
  fire-and-forget runGuide remains" sweep across all three drivers.

## [0.14.39] — 2026-06-11 — chain audits fail honestly (fixes ×1/×3/×5 "does not continue")

### Fixed

- **Audit ×N chains and pipelines no longer mask a failed audit as "duplicate
  audit" / a false clean stop.** Both chain drivers fired audits without
  checking the result: `await runGuide({task:'audit'})` in the job-runner ×N
  loop (initial + every re-audit) and in pipeline.js stage 2. When an audit
  FAILED (two-stage scan error, exhausted retries, API error) the chain
  proceeded to promote anyway, found only the PREVIOUS audit file, hit its
  per-audit sentinel, and stopped as "duplicate audit — pipeline stopped" —
  the real failure swallowed, the ×3/×5 flow dead at round 1 or 2 with a
  misleading reason. Now: a failed initial audit fails the job with `audit
  failed: <reason>`; a failed re-audit stops the chain with `audit failed on
  round N: <reason>` (completed rounds preserved); pipeline returns
  `stoppedAt:'fixes', reason:'audit failed (round N): …'`. The .36 two-stage
  split doubled the audit's failure surface, which is what surfaced this
  pre-existing swallow. *(server/job-runner.js, pipeline.js)*

### Verify

- `scripts/verify-v0_14_39.mjs` — 7 checks: both job-runner sites capture +
  check results, no fire-and-forget audit calls remain in the chain, re-audit
  failure breaks before promote runs, pipeline check + preserved preflight
  handling, version stamp.

## [0.14.38] — 2026-06-11 — self-healing: in-run opus retry, validation-failed guards, honest notifications

> Night-run batch. The escalation machinery existed (.36) but handed the human
> a 2am resume whose only effect was letting the marker do its job; failing
> commits could be reconciled as "complete" on resume; and notifications
> mislabeled fixes as "phase-undefined", showed the agent's cheerful "Done…"
> text instead of the real failure reason, and framed clean audits as "chain
> stopped". All four observed live on aoa/asp.

### Changed

- **In-run failure escalation — the run consumes its own opus marker instead of pausing.**
  First non-timeout dev/fix failure: the loop `continue`s (skipping
  evaluatePause), the escalation marker routes the immediate re-pick to Opus,
  and any validation-failed excerpt rides into the retry prompt. Pause happens
  only when the Opus attempt ALSO fails. One auto-retry per phase/fix per run
  (`escalateRetryDone`); timeouts stay with the existing reprompt flow.
  `auto_run.auto_escalate_on_failure:false` restores pause-on-first-failure.
  *(auto-runner.js, defaults.json)*
- **Escalation markers extended to fixes** (`fix-rR-N-escalate-opus.marker`) —
  written on fix-dev failure, consumed by runDev's fix path, cleared at gate
  pass. *(auto-runner.js, phase-runner.js)*
- **Validation-failed markers close the reconcile bypass.** A commit that
  failed the validator gate could previously be resurrected as "complete" by
  three shortcuts: the phase `phaseCommitSha` reconcile, the fix self-heal in
  `pickBugAction`, and the fix report-exists idempotency gate. The gate now
  persists its failure excerpt to `…-validation-failed.marker`; all three
  shortcuts check it and re-run instead of reconciling; the next attempt's
  prompt includes the excerpt under "PREVIOUS ATTEMPT FAILED VALIDATORS — fix
  FORWARD". Cleared when the gate passes. *(phase-runner.js, auto-runner.js)*
- **Honest notifications.** Pause messages now use the orchestrator's
  `error_message` (validator gate / no-commit / …) instead of the agent's
  final text, and label fixes correctly (`fix r2-3` — was `phase-undefined`);
  unattended pauses carry the label+reason too (was a bare "phase-error").
  Clean-audit pipeline endings now read "✅ pipeline complete — audit came
  back clean, nothing to fix" instead of "chain stopped". *(checkpoint.js,
  auto-runner.js, server/job-runner.js)*
- verify-v0_14_36.mjs: escalation-marker cleanup pin relaxed from exactly-2 to
  ≥2 unlink sites (.38 adds the gate-pass cleanup — strengthened invariant).

### Verify

- `scripts/verify-v0_14_38.mjs` — 16 checks: in-run retry wiring + timeout
  exclusion + knob, fix-scoped markers + gate-pass cleanup, all three
  reconcile guards + forward-fix injection, functional checkpoint label/reason
  rendering, clean-audit success wording, version stamp.

## [0.14.37] — 2026-06-10 — escalation scoped to execution tasks, inline fix prompts

> Batch 4 — both items proven by the live 30d /spend report ($2,556.69 total).

### Changed

- **Keyword + complexity escalation now applies ONLY to execution tasks.**
  `runGuide` passes the project's NEXT phase meta into routing for every guide
  task, so a project sitting in front of a phase titled "FVU generator" had
  its prompt-gens, reviews, and bug-plans `force_tier`'d to Opus by that
  phase's TITLE — tasks that merely talk about the phase, not execute it. The
  /spend receipts: `phase-prompt-gen·opus` $132.79 (73×), `3-phase-review·opus`
  $68.79 (43×), `bug-plan·opus` $82.57 (72×, plus most of the 4.7-era $62.96)
  — ~$280/mo of pure misrouting that neither the v0.14.36 prefer_top
  retirement (complexity path only) nor the floors (minimums, not caps)
  touched. The router now gates Step 3 (keyword rules) and the phase-derived
  half of Step 4 (turns/criteria/files signals) behind a new top-level
  `escalation_tasks` allowlist in model-routing.json, default
  `["dev-execution", "fix-execution"]`. Non-execution tasks route on baselines
  + floors with an explicit reasoning line ("phase meta ignored"); execution
  tasks are untouched — regulatory-core still forces Opus on the phases and
  fixes it was written for. *(model-router.js, model-routing.json)*
- **Inline fix prompts — the per-fix `fix-prompt` guide call is gone by default.**
  The /spend data overruled the v0.14.35 decision to keep it: `fix-prompt-gen`
  ran 505 times writing 5.3M output tokens — effectively 1:1 with the 540
  fix-executions and their 5.4M output. That's restatement, not synthesis:
  `bugs.md` (canonical Steps/Expected/Actual/Affected-files format) and the
  round's `plan.json` entry already ARE the spec. With
  `fixes.inline_fix_prompts: true` (new default), a missing prompt.md routes
  straight to fix-dev and `runDev` builds the prompt from the fix's plan.json
  entry (embedded verbatim as JSON), pointers to the round's bugs.md ("each
  bug's Expected is your acceptance criterion"), the brief's
  Conventions/NFRs, decisions.md, and the `fix-r{round}-{n}:` commit format —
  with explicit no-scope-creep rules. A prompt.md on disk always wins
  (hand-written prompts keep working). The dev's report-path header,
  decisions-log injection, validator gate, and fix-commit idempotency are all
  upstream/downstream of the prompt source and unchanged.
  `inline_fix_prompts:false` restores a guide call per fix. ~$280/mo at
  current volume. *(phase-runner.js — `buildInlineFixPrompt`; auto-runner.js
  `pickBugAction`; defaults.json)*

### Verify

- `scripts/verify-v0_14_37.mjs` — escalation gate proven via live routeModel
  (regulatory meta on review/prompt-gen/bug-plan stays Sonnet with the skip
  reasoning line + low complexity despite heavy meta; dev-execution and
  fix-execution still force Opus on core patterns; domain min-tiers
  unaffected), allowlist default + config knob, inline fix prompt contract
  (entry JSON embedded, bugs.md pointers, commit format, scope rules,
  null-entry fallback), runDev branch order (file wins → phase inline → fix
  inline → throw), pickBugAction gate, defaults knob, version stamp.

## [0.14.36] — 2026-06-10 — two-stage audits, plan validation with auto-regen, failure-driven escalation

> Batch 3 closes the cost/quality pass: the last big Opus input (full-audit
> codebase reads) goes to Sonnet, broken plans get caught for free before they
> burn phases, and Opus escalation now keys off the one signal that means
> something — a phase actually failing.

### Added

- **Two-stage full audits: Sonnet scan → Opus adjudicate.** A full audit was
  one Opus call reading the entire codebase. Now stage 1 (`audit-scan`, Sonnet
  baseline, no opus floor, its own row in `/spend`) reads the codebase and
  emits CANDIDATE findings — `### CAND-n` entries with file:line, ≤6 verbatim
  evidence lines, a suspicion sentence, and a severity *guess* — to
  `.guide/audits/scan-<ts>.md`, explicitly instructed to over-report
  borderline items (recall is its job) and to never write a promote section or
  Bug-N headings (the parser scans for those). Stage 2 (`audit`, Opus via the
  existing floor) adjudicates ONLY the candidate list + brief + plan: confirms
  with final severity or kills as false positive (with a "## Killed
  candidates" section naming each kill and why), merges duplicates, and writes
  the final audit including the v0.14.34 promote rules and clean-audit line.
  It may open individual files solely to confirm/refute a candidate — reads
  stay surgical. Opus input drops from O(codebase) to O(findings), and Opus
  capacity goes to judgment instead of file traversal. The
  `.last-audit.json` SHA stamp lands exactly as before, so the NEXT audit goes
  incremental off this one. Incremental re-audits stay single-call (their
  input is already O(diff)). Scan failure or a missing candidates file aborts
  before the Opus call. `audit.two_stage:false` restores the single Opus full
  audit. *(phase-runner.js — `runTwoStageAudit`, `buildAuditScanPrompt`,
  `buildAuditAdjudicatePrompt`, hoisted `AUDIT_PROMOTE_RULES` +
  `detectIncrementalAudit`; defaults.json — `models.audit-scan`,
  `audit.two_stage`)*
- **Mechanical plan validation with one auto-regen.** Most structurally broken
  plans (duplicate phase numbers, numbering gaps, missing titles/goals, empty
  acceptance criteria, a continuation plan whose first phase isn't ahead of
  `current_phase` — i.e. dead on arrival for `pickNextAction`) are checkable
  without a model. New `src/lib/plan-validate.js` does exactly that, free and
  deterministic, immediately after every plan generation. Problems → the list
  is written to `.guide/plan-fix.hint`, the plan prompt injects it ("you MUST
  fix these specific problems"), and the plan regenerates ONCE; still broken →
  the action fails and the run pauses on `phase-error` instead of executing a
  dead plan. The hint is cleared once a plan passes. *(plan-validate.js,
  auto-runner.js post-plan block, phase-runner.js plan prompt;
  `models.plan-validate` added so the existing FR-coverage gate stops warning
  about a missing model key)*
- **Coverage BLOCKER now auto-regens once before pausing.** The pre-phase-1
  FR-coverage gate used to pause immediately on BLOCKER and ask the operator
  to hand-fix and delete files. First BLOCKER now injects the blocker lines
  via the same `plan-fix.hint` ("every brief FR must be covered; do not drop
  existing phases"), regenerates the plan, and re-validates coverage from
  scratch — `.guide/.coverage-regen-attempted` is the one-shot budget, cleared
  on a CLEAR verdict. A second BLOCKER pauses with the original guidance.
  *(auto-runner.js)*

### Changed

- **Opus escalation is now failure-driven; complexity escalation retired.**
  `prefer_top_for_critical` is set `false`: one keyword hit or a high
  max_turns/criteria count was a weak proxy that silently sent phases to Opus
  preemptively (and double-fired with force_tier through the critSignals
  path). The replacement signal is the real one: when a dev phase FAILS — agent
  error, no-commit, or validator-gate failure — an
  `.guide/phase-N-escalate-opus.marker` is written, and the phase's next
  attempt runs Opus regardless of routing (with an explicit reasoning line).
  The marker clears on phase completion, both normal and reconciled paths. The
  narrow `force_tier` rules (regulatory-core, security-core) are untouched —
  those are deliberate. Flip `prefer_top_for_critical` back to `true` to
  restore the old behavior; `/spend` (task × model deltas before/after) is the
  arbiter. *(model-routing.json, phase-runner.js, auto-runner.js)*

### Verify

- `scripts/verify-v0_14_36.mjs` — functional plan-structure scenarios
  (duplicates, gaps, ordering, missing fields, reachability), plan-hint
  injection, regen wiring + coverage-regen budget, two-stage prompt contracts
  (scan never writes promote sections; adjudicate kills with reasons),
  incremental-detection extraction parity, escalation marker
  routing/cleanup/write sites, prefer_top retirement proven via live
  routeModel (critical complexity stays Sonnet; regulatory force_tier still
  Opus), version stamp.

## [0.14.35] — 2026-06-10 — validator hard gate, inline phase prompts, qa-handoff routing fix, haiku retired

> Batch 2 of the cost/quality pass. v0.14.34 cut what audits cost; this one
> cuts what phases cost — one fewer Sonnet call per phase, deterministic
> verification before any model review, and two config/routing inconsistencies
> closed.

### Added

- **Validator hard gate — a failing phase can no longer reach review, completion, or origin.**
  Pre-v0.14.35, validators ran in the auto-runner AFTER `runDev` had already
  committed, marked the phase complete, and pushed — a failure paused the run
  but the broken phase was already terminal and on origin. The gate now runs
  INSIDE `runDev`: after the agent's commit, BEFORE `markPhaseCompleted` and
  `pushBranch`, for phases and fixes alike. Configured `validators.json`
  chains run first; projects without one (or with no matching rules) fall back
  to a built-in default: `npm test` when workspace/package.json has a real
  test script (the npm-init `echo "Error: no test specified"` placeholder
  doesn't count), else `node --check` on the JS files changed since the
  phase's pre-SHA — cheap, deterministic, and it never blocks a project for
  *lacking* tests, only for committing syntax errors. On failure the gate
  grants ONE mechanical retry: the dev session is resumed with the validator
  output injected ("fix exactly what this output indicates — nothing else"),
  then re-gated. Still failing → the phase is marked `failed` with the
  validator summary, the commit stays local (origin stays clean; `/retry` can
  delete it), and the run pauses on the standard `phase-error` checkpoint —
  including unattended mode. The auto-runner's legacy post-hoc validator pass
  short-circuits when the gate already ran (`result.validator_outcome`), so
  nothing validates twice. Config: `validators.default_gate:false` disables
  only the built-in fallback (configured chains keep gating);
  `validators.default_test_timeout_ms` (180s) and `default_check_timeout_ms`
  (30s) bound the defaults. This is a cost cut AND the largest dev-quality
  lever in the pipeline: no Sonnet review of code that doesn't parse, no
  review→fix→review loop for failures a test run catches for free.
  *(validators.js — new `runValidatorGate` / `runDefaultGate` /
  `gateFailureExcerpt` / `hasRealTestScript`; phase-runner.js; auto-runner.js;
  defaults.json)*
- **Rolling decisions log** at `.guide/decisions.md`. Every review now APPENDS
  an "## After phase N" heading with 2–6 one-line durable
  decisions/conventions/gotchas (and is told to skip phase-specific trivia).
  Every dev run — inline-prompted or prompt.md-based — gets the file's tail
  (last 80 lines, capped so long projects don't bloat context) injected as a
  binding `<decisions_log>` block, alongside the existing brief-constraints
  and project-context blocks. *(phase-runner.js — `loadDecisionsBlock`)*

### Changed

- **Inline phase prompts — the per-phase `next-prompt` guide call is gone by default.**
  That call re-read plan + brief + reports to mostly restate plan.json's phase
  spec: ~⅓ of guide-call volume and a serial wall-clock step per phase. With
  `phases.inline_phase_prompts: true` (new default), a missing prompt.md no
  longer routes through the guide — `runDev` builds the dev prompt directly
  from the plan's phase spec (goal, notes, acceptance criteria, files
  expected) + a pointer to decisions.md + the brief's
  Conventions/NFRs/Gotchas. Precedence is explicit: a prompt.md on disk ALWAYS
  wins (manually authored prompts keep working), and the
  auto-reprompt-on-timeout path — which deletes prompt.md so the guide can
  regenerate a tighter one — still gets its guide call (the hint file routes
  it). The skip-repair rewind path goes straight to dev under inline too.
  Fixes keep their per-fix `fix-prompt` generation: bug-specific synthesis
  earns its call. Set `inline_phase_prompts:false` to restore the old
  guide-call-per-phase flow. *(auto-runner.js — both pickNextAction sites;
  phase-runner.js — `buildInlinePhasePrompt`; defaults.json)*
- **qa-handoff now routes through `routeModel` like every other call site.**
  `withSteps()` read `cfg.models.audit` directly, so `hard_floors.audit=opus`
  never applied and the "single batched Opus call" comment was false — it ran
  Sonnet (the models.audit baseline). The floor now decides (→ Opus today);
  if `/spend` later shows Opus isn't earning it on handoffs, flip the floor —
  one knob, one source of truth. *(qa-handoff.js)*
- **Haiku tier retired.** It was configured but unreachable in practice
  (tier_caps blocked it for dev and reviews; nothing ever routed to it).
  Removed from `tier_order`, `tier_models`, and the router's fallback literal;
  `tier_caps` deleted from model-routing.json along with the dead Step-7 cap
  logic. A stray haiku tier arriving via a project routing-extension or legacy
  phase `model_override` now clamps to sonnet with an explicit reasoning line.
  Less config to reason about; zero behavior change for anything that actually
  runs. *(model-router.js, defaults.json, model-routing.json)*

### Verify

- `scripts/verify-v0_14_35.mjs` — 32 checks: default-gate behavior (9
  functional scenarios: passing/failing npm test, node --check isolating the
  broken file, placeholder detection, skip-pass, enabled/default_gate
  toggles), gate wiring order in runDev (gate before completion, retry resumes
  session, failure returns before push), auto-runner short-circuits, inline
  prompt content + decisions tail-cap + reprompt-hint routing, review/
  next-prompt decisions instructions, qa-handoff routing, haiku absence +
  stray-tier clamp, version stamp.

## [0.14.34] — 2026-06-10 — cost cuts without quality loss: incremental re-audits, severity-gated promote, two-strike stall escalation, /spend

> Theme: reduce Opus/high-tier usage where it demonstrably adds nothing, and add
> the measurement to prove it. The single biggest waste was chained audits
> re-reading the entire codebase on Opus every round; the rest were escalation
> paths that fired on weak signals.

### Added

- **Incremental re-audits — chained audits stop re-reading the whole codebase.**
  After every successful audit, `runGuide` stamps the workspace HEAD SHA into
  `.guide/audits/.last-audit.json`. The NEXT audit, if a prior audit + marker
  exist and the workspace is a git repo, scopes itself to (1) verifying every
  CRITICAL/MAJOR finding of the previous audit against current code with
  file:line evidence, and (2) auditing only the files in
  `git diff <stamped-sha>..HEAD` (plus direct callers/callees when a contract
  changed). Falls back to a full audit when: no marker, no prior audit, not a
  git repo, the SHA is gone (force-push/rebase), or the diff exceeds 150 files.
  Delete `.guide/audits/.last-audit.json` to force the next audit to full
  scope. On audit→fix auto-chains (`--auto` ×N, pipeline rounds) this cuts the
  Opus input from O(codebase) per round to O(diff) — and is higher-signal, not
  just cheaper: re-audit's job is fix verification + regression detection, and
  full re-scans mostly regenerated the same MINOR noise. A prior finding that
  is still open or only partially fixed keeps its severity and goes back into
  the promote section. *(phase-runner.js, git.js — new `changedFilesSince`)*
- **`/spend [project] [days]` — actual spend by task × model.** The measurement
  counterpart to `/predict` (estimates) and `/budget` (lifetime cap): groups
  the `calls` table over a trailing window (default 30d, clamped 1–365),
  ordered by USD, with token volumes compacted for a phone screen, a
  per-project breakdown, and an explicit count of rows lacking cost data. Args
  are optional and order-free — a bare number or `45d` is the window, anything
  else is a project name (validated). Aliases `/spent`, `/costs`. Registered
  but menu-excluded (same power-user class as `/budget`; keeps the dropdown at
  the 25-entry cap). Read-only; DB layer lazy-imported so the render helpers
  stay dependency-free. *(new lib/cost-report.js, telegram-parity-handlers.js,
  server.js, command-menu.js comment)*

### Changed

- **Promote section is now severity-gated — MINORs stop churning fix rounds.**
  The audit prompt (full AND incremental) and `audit-template.md` now require:
  CRITICAL/MAJOR findings ONLY in `## Promote to bugs-round-N`; MINOR and
  DEFERRED-OK findings are appended to `.guide/audit-backlog.md` instead
  (dated heading; backlog entries must use `### M1 — <title>` style headings,
  never "Bug N" style, because the promote parser's level-2 fallback scans for
  Bug-N headings anywhere in the file). Pre-v0.14.34, chained `--auto` rounds
  promoted whatever the model put in the section — typically a tail of MINORs
  — burning a bug-plan + fix-execution + re-audit cycle on cosmetic churn.
- **Deterministic clean-audit signal.** A clean audit now writes the promote
  heading with exactly one line under it: `(nothing to promote — no CRITICAL
  or MAJOR findings)`. `audit-promote.js` recognizes that line in
  `buildResult` and returns `{ found: false, clean: true }` — the auto-chain's
  early-stop fires cleanly instead of depending on the section being absent
  (which the level-3 position heuristic could mis-detect) or, worse, creating
  a junk bugs round out of the placeholder text. A promote section containing
  the marker line AND real Bug entries still promotes — the clean verdict
  requires every meaningful line to match. *(audit-promote.js)*
- **Stall escalation is now two-strike (was: one stall → Opus).** First stall:
  retry on the SAME model with a fresh session (drops `--resume` — stalls are
  usually bloated-context/environmental, and the session drop clears exactly
  that). Second consecutive stall: escalate to Opus as before. Non-stall
  transients reset the streak. Pre-v0.14.34 a single stall on a cosmetic phase
  bought an Opus retry at full phase context. *(claude-runner.js)*

### Verify

- `scripts/verify-v0_14_34.mjs` — 32 checks: clean-audit signal (4 functional
  scenarios), incremental/full audit prompt branching (7 functional scenarios
  incl. dead-SHA and verification-only), `changedFilesSince` guards, stall
  two-strike source assertions, `/spend` wiring + render output, menu cap,
  template gate, version stamp.

## [0.14.33] — 2026-05-30 — self-audit fixes + audit/pipeline autopilot + guide-task git sync

> **Version resolved to 0.14.33.** `package.json` previously said `0.14.28` while
> `scripts/` already had `verify-v0_14_29` … `verify-v0_14_32` harnesses (and
> `test-runner.js` is tagged v0.14.29) — so 29–32 were taken. The next free number
> is **0.14.33**; `package.json` and this heading are now set to it together (the
> release builder enforces `arg == package.json version`).
>
> **Also fixed in this pass:** `.gitignore` and `.releaseignore` were claimed
> "Added" below but were actually absent from the tree — they're now present, which
> unblocks `scripts/build-release-zip.sh` (it aborts when `.releaseignore` is
> missing) and prevents the recursive-clone hazard when the orchestrator is
> registered as a project. The full pipeline now also stops after authoring a brief
> *from scratch* (review gate; `--auto-brief` bypasses) and converts a workspace git
> divergence into a clean "reconcile" stop instead of a raw job failure.

### Fixed

- **`/cancel` is now worker-pool-safe (was: cancelled the wrong project).**
  `claude-runner.js` tracked the running subprocess in a module-level singleton
  ("safe because the server runs ONE job at a time") — an invariant the v0.14.4
  worker pool (default 8 concurrent) silently broke. Every spawn overwrote the
  singleton, so `killCurrent()` could only target the *most-recently-spawned*
  proc: `/cancel A` would SIGTERM project **B**'s claude, leave A running, and
  let the shared cancel flag mis-classify an unrelated completing job. Replaced
  the singletons with a per-`jobId` registry (`_procs` map + `_cancelRequested`
  set), keyed off the worker context. `/cancel <A>` now kills only A's
  subprocess (SIGTERM → SIGKILL after 5s) and never touches siblings. This was
  the "cancellation race" deferred in the 0.14.8 notes. *(claude-runner.js,
  telegram-handlers.js)*
- **Cancelled jobs can no longer be silently un-cancelled.**
  `markJobCompleted` / `markJobFailed` / `markJobCancelled` were unconditional
  `UPDATE … WHERE id = ?`. Now guarded with `AND status = 'running'`, making
  `cancelled` terminal — a late completion from a (previously un-killed)
  subprocess can't flip the row back to `completed`. `clearStaleRunningJobs`
  still sweeps stale `running` rows unchanged. *(job-queue.js)*
- **No more scary "✗ Failed" notification after a successful cancel.**
  Now that the cancel actually SIGTERMs the right subprocess, the job throws
  `cancelled (signal …)` into `executeJob`'s catch. That catch is now
  cancellation-aware: it marks the row `cancelled` (if not already) and
  swallows the throw instead of double-notifying with a failure. *(job-runner.js)*
- **Release builder no longer trusts `.releaseignore` alone (live-data leak vector).**
  The rsync (primary) path relied solely on `--exclude-from=.releaseignore`,
  while only the cp fallback hard-removed `state/ logs/ node_modules/ .git/`.
  A missing pattern would have shipped the live SQLite DB or the operator's bot
  token. The rsync path now carries the same hard `--exclude` floor as the cp
  fallback; the staging guard fails on a leaked `state/`/`logs/`/etc. (not just
  `telegram.json` + `projects/`); and the final zip check is broadened (and
  skips `unzip`'s `Archive:` header so the `dist/` output path doesn't
  false-match). *(build-release-zip.sh)*
- **Budget-pause now offers a Resume button.** The `BUDGET` branch of
  `next-actions.js` told the user to "bump the budget then resume" but — alone
  among the pause kinds — shipped no Resume affordance. Added. *(next-actions.js)*

### Added

- **Audit → bugs → fixes auto-chain (`/run <project> audit --auto`).** Previously
  a self-improvement loop took three operator taps: `/run audit`, then
  `/bug_promote --from-audit`, then `/run go`. With `--auto` (or `--chain`, or
  the new config default `auto_run.chain_audit_to_bugs`) a single audit job now
  carries all the way through: it runs the audit, promotes the "Promote to
  bugs-round-N" section into a fresh `bugs.md`, then hands that round to the
  existing unattended `autoRun` — which generates the fix plan and executes
  **every** fix without further prompting, pausing only on a blocker
  (`auto_pause_on_error` / budget) or when the round completes. A clean audit
  (no actionable findings, or a drifted template) does **not** fabricate an
  empty round — the chain stops with `✓ Completed — chain stopped: <reason>` and
  the manual Promote next-action, so a 0-finding audit still reads as "revise
  the brief", per the operator's own rubric. Because the chained run reuses the
  proven `autoRun` result handling, a *completed* round classifies as
  `FIX_ROUND_COMPLETE` (QA / ship / next-round next-actions — **no misleading
  Resume button**) while a genuine blocker classifies as `MID_BUILD`/`BUDGET`
  (Resume offered) — i.e. "run to completion, only ask me on a real blocker".
  Nothing is shipped to `main`: the whole chain lives in `workspace/` on
  `develop`, so the review-before-ship boundary is untouched. Wired into both
  entry points (Telegram `/run … audit --auto` and `npm run audit -- … --auto`).
  **Button-driven:** tapping 🔍 Audit in the project view now opens an
  "Audit only / Auto ×1 / ×2 / ×3 / ×5" menu, so the pipeline and its round count
  are selectable without typing a flag. **Repeatable:** `--rounds N` (or the ×N
  buttons; max 10) re-runs the whole pipeline up to N times, re-auditing the
  changed workspace between rounds and stopping early when an audit comes back
  clean or a blocker hits.
  The file-writing half of promotion is now a single shared
  `promoteAuditToBugs()` in `audit-promote.js` so the chain and the manual
  CLI/Telegram paths can't drift. *(audit-promote.js, job-runner.js,
  telegram-handlers.js, orchestrator.js, config/defaults.json + schema)*
- **`scripts/verify-audit-chain.mjs`** — runnable contract test for
  `promoteAuditToBugs` (happy path, explicit-round collision, append,
  auto-advance to the next round, clean-audit no-op, missing-audit) plus the
  pure pipeline helpers (`roundCleanlyDone`, `stageEnabled`). Needs no
  Claude call, DB, or worker pool. 32 checks, exit 0 = pass.
- **Guide tasks now pre-flight pull `develop` (v0.14.33).** `runDev` (phases/fixes)
  already fetched + fast-forwarded the workspace before running, but `runGuide`
  (audit, roadmap, plan, brief-author, bug-plan, review) did not — so an audit
  could analyze a stale clone and a later push could collide. `runGuide` now runs
  the same `preflightForDev` + `syncWithRemote` block before every guide task:
  fast-forwards when behind, no-ops when in sync, and HALTS on divergence (no
  auto-rebase) — so the analyze/edit stages always see the latest code and we
  don't manufacture conflicts. This covers audit/roadmap everywhere they run —
  standalone, via the audit auto-pipeline, and inside the full pipeline (whose
  build stage was already covered by `runDev`). Skipped for projects with no
  `git_branch`. *(phase-runner.js)*

 One command/tap chains every safe-to-automate stage:
  requirements/roadmap intake → brief (authored only if missing) → build
  (`autoRun` auto-plans + runs phases/reviews/existing bug rounds) → drain the
  bug inbox → audit → promote → fixes (× `--rounds`, re-auditing until an audit
  comes back clean) → QA handoff — then **stops at the ship gate**. It never
  ships and never spins off new projects (both stay operator-controlled);
  roadmap items route through the requirements inbox rather than creating
  projects. Stops at the first blocker (a build/fix run that fails or pauses on
  budget/validator/mid-build), inheriting that result so the post-switch
  dispatch surfaces Resume/Bump. `--stop-after brief|build|fixes|qa` (and the
  "Build only" / "Brief only" buttons) allow incremental validation and a
  brief-review gate. The driver (`src/pipeline.js`) is a thin sequencer over
  already-tested primitives (`autoRun`, `runGuide`, `promoteAuditToBugs`,
  `performBugPromote`, `performReqPromote`, `generateQaHandoff`); the only new
  logic is the ordering + the blocker-stop predicate, both unit-tested.
  *(pipeline.js, job-runner.js, telegram-handlers.js, orchestrator.js,
  package.json)*


  `.gitignore` keeps `state/ logs/ outputs/ projects/* config/telegram.json
  node_modules/` out of the repo (critical for the dogfooding case, where the
  orchestrator is registered as a project — otherwise a clone nests its own
  workspace recursively) while keeping `projects/.gitkeep`. `.releaseignore` is
  the documented source of truth the builder reads.
- **`killAll()` in `claude-runner.js`**, wired into the server's *forced*
  shutdown (second Ctrl-C) and drain-timeout paths so a hung job's subprocess
  is SIGTERM'd rather than orphaned. The graceful-drain path is unchanged.
- **`scripts/verify-cancellation-worker-safe.mjs`** — proves per-job kill
  isolation against the real exports (incl. "killing jobA leaves jobB
  untouched") plus static checks for the status guards, the Resume button, and
  the builder hardening. 23/23 pass.

### Changed

- **`docs/TELEGRAM_BOT.md`** — the two notes calling mid-phase cancellation
  "soft (subprocess continues to completion)" now describe the real per-job
  hard-cancel.



### Added

- **`/extend <project>`** — interactive decision tree for "I want to add
  new work to an existing project." Surfaces the three real paths and
  routes the user to whichever fits:
    - 🐛 **Small refinements / QA fixes** — activates bug-capture mode,
      same effect as `/coach`'s capture button.
    - 📈 **New features (extend this project)** — explains how new
      phases get added (only when the brief describes new functional
      surface area), offers two ways to update the brief (Telegram
      `/req` or Mac edit), and a `♻️ Regenerate plan now` button that
      queues a guide job.
    - 🆕 **Big new direction (new project)** — shows the
      `/new_project <name>-v2 <git-remote>` invocation with a sensible
      default name.
    - ❓ **Help me decide** — decision tree text (file-PR-repo heuristic)
      with edge-case examples and routing buttons.
  Aliases: `/add_work`, `/add`, `/more`.
- **`🔧 Add new work (extend)` button** added to `/coach`'s
  "built and waiting" rule so users discover `/extend` naturally.

### Changed

- **`/budget` dropped from the autocomplete dropdown** to stay under
  Telegram's 25-command menu limit. The command itself is still
  registered and runnable — just not in the `/` autocomplete. Session
  cost is visible via `/status`; lifetime cost via `/help` → `/budget`.

### Why this exists

Recurring confusion: adding requirements via `/req_promote --plan`
doesn't necessarily grow the phase count. The model often folds new
reqs into existing phase descriptions or treats them as refinements.
When the project is already at `current_phase == total_phases`, the
folded work never executes. The `/coach` rule for "built, waiting on
you" was honest about this but didn't route the user to a concrete
next step. `/extend` provides that routing as a one-tap workflow.

### Notes for future work

- The phases-path "♻️ Regenerate plan now" button currently asks the
  user to manually compare phase counts after regen (via `/preview
  ... plan` and `/predict`). A follow-up could plumb the old phase
  count through to a post-regen DM that says "old: N, new: M — N+1
  phases of new work, ready to /run go." Requires modifying
  `job-runner.js` to detect the `extend_regen` arg flag.
- The new-project path is currently informational only — it tells the
  user to run `/new_project`. A future improvement could collect the
  args (new name + git remote + branch) interactively via reply-prompt
  callbacks.

## [0.14.27] — 2026-05-26

### Fixed

- **`/coach`'s `📋 QA handoff`, `📖 Read brief/plan/audit/bugs/review/roadmap`,
  `💰 Predict cost first`, and `📊 Git status` buttons all responded with
  `Unknown action`.** Coach was producing callbacks with prefixes
  `qa:`, `preview:`, `predict:`, `git:` — but the callback dispatcher
  in `src/server/telegram-handlers.js` had never been updated when
  those rules were added. The buttons rendered fine on screen; tapping
  them just hit the dispatcher's fall-through.
- Four callback handlers added, each synthesising `ctx.match` and
  re-invoking the existing `/command` handler:
    - `qa:<project>` → `handleQaHandoff`
    - `predict:<project>` → `handlePredict`
    - `preview:<project>:<artifact>` → `handlePreview` (with `<project> <artifact>` in match)
    - `git:<project>` → `handleGitStatus`

### Notes

- Cross-reference check added during build: every callback prefix
  produced by `src/lib/coach.js` is now confirmed to have a matching
  `action === '...'` branch in the dispatcher.
- Future regression-prevention idea: a startup-time invariant that
  walks `coach.js` for `callback: \`prefix:\`` patterns and asserts
  each prefix has a dispatcher branch. Half-hour of work, would have
  caught this. Filed mentally as worth doing if more callbacks get
  added.

## [0.14.26] — 2026-05-26

### Fixed

- **Filenames in `/coach` output and pause notifications were auto-linked
  as URLs.** Telegram treats `.md` (Moldova) and other ccTLD-collision
  extensions as domain TLDs. The auto-runner's pause reason
  (`"All N phases + final review complete. Run manual QA, then drop
  bugs-round-1.md..."`) bubbled into two places — `/coach`'s
  `headline` and `job-runner.js`'s `⏸ Paused`, `✓ Completed`, and
  `✗ Failed` notifications — where it rendered as clickable
  `<https://bugs-round-1.md/>` links. Same bug class as the
  `raw-thoughts.md` autolink fixed at the `/req_promote` site only in
  v0.14.20.

### Added

- **`src/lib/telegram-fmt.js`** — centralised sanitiser for strings
  bound for Telegram HTML messages. `sanitizeForTelegram(s)` =
  escapeHtml + wrapFilenames in a single pass. Filename pattern
  recognises 28 extensions known to collide with TLDs or cause
  rendering issues: `md, json, js, mjs, cjs, ts, tsx, jsx, yml, yaml,
  toml, lock, html, css, sh, py, rb, go, rs, java, sql, log, txt,
  csv, tsv`. Pattern is intentionally narrow — broader matching
  would risk wrapping things like version strings ("v1.2.3") that
  aren't filenames.

### Changed

- **`src/server/telegram-parity-handlers.js`** — `handleCoach` now
  routes `headline`, `suggestion`, and `why` through
  `sanitizeForTelegram` instead of plain `escapeHtml`.
- **`src/server/job-runner.js`** — three notify sites (paused /
  completed / failed) plus the outer-catch failure path all
  sanitize their `reason` / `summary` strings before sending.
  Lazy import (inside the worker function) so the CLI path doesn't
  pay the import cost.

### Notes

- For future work touching any code that emits Telegram messages
  containing user-controlled or model-generated content, import
  `sanitizeForTelegram` from `src/lib/telegram-fmt.js` rather than
  calling `escapeHtml` directly. The escape-only path leaves
  filename autolinks alone.
- If a new file extension starts showing up as an autolink in
  Telegram messages, add it to the `FILENAME_EXTS` array in
  `telegram-fmt.js` — no other code change needed.

## [0.14.25] — 2026-05-26

### Fixed

- **`/coach` Resume loop on completed projects.** When an auto-run
  finishes all phases, the orchestrator marks the run paused with
  `pause_reason: "All N phases + final review complete..."`. Coach
  rule #2 was matching on `status === 'paused'` and suggesting
  `⏯ Resume`, which immediately re-paused with the same message —
  an infinite loop, just one tap apart. Rule #2 now inspects
  `pause_reason` and routes the "all phases complete" case to a
  separate response with actions that make sense for a built project
  (`🐛 Capture a QA bug`, `📋 QA handoff`, `🔍 Final audit`, `🚢 Ship`,
  plus shortcut buttons if criticals are already in the inbox).
- **`/predict` on a completed project showed a cryptic "no upcoming
  work" message.** Now shows phase context (`currently at phase N/M`)
  and the same actionable buttons as the coach's new "completed"
  rule. Predict on an active project is unchanged.

### Added

- **`bug:start:<project>` callback** — coach's "Capture a QA bug"
  button now activates the same multi-message bug-capture mode that
  `/bug_capture <project>` enables. One tap → send each QA finding as
  a message → `/bug_done` → `/bug_promote` to run the fix round.
- **`bug:promote-critical:<project>` callback** — coach's "Promote N
  critical bugs" button (visible when criticals already exist in the
  inbox) now invokes `/bug_promote <project> --critical` without
  requiring the user to type the command.

### Notes

- These fixes mean the full "QA findings → ship" loop is now
  achievable entirely from Telegram without CLI fallback, even on a
  project that has finished all phases. The flow:
    1. `/coach <project>` (or just `/coach` with pin) — bot tells you
       the project is built and shows a button list
    2. Tap **🐛 Capture a QA bug** — bug capture mode on
    3. Send each finding as a message
    4. Send `/bug_done`
    5. Send `/bug_promote <project>` (or tap the bot's reminder)
    6. Bug round runs to completion, DMs you when fixes are done
    7. `/ship <project>` (confirmation button) → merged to main

## [0.14.24] — 2026-05-26

### Added

- **`docs/FLOW_ROADMAP.md`** — dedicated flow doc for the
  `/run &lt;project&gt; roadmap` action and the CLI-only `roadmap-accept`
  follow-up. Covers: when to run it, the two acceptance modes
  (`--new-project` vs `--to-inbox`), item-selection syntax, and the
  edge cases (no plan, unparseable items, multi-project spawn).
- **`/coach` now surfaces unacted-on roadmaps.** New rule 11b in
  `src/lib/coach.js`: when a project is quiescent (no active run, all
  phases complete or none, no in-progress bug round) and has a
  roadmap file, coach suggests reading it with buttons for preview /
  capture-as-requirement / generate-fresh. Positioned after the
  audit-before-ship rule because audit is more time-urgent.

### Changed

- **`docs/FLOWS.md` index updated** — "five core flows" → "six core
  flows," roadmap added to the connection diagram showing its two
  output paths (`--new-project` feeds the lifecycle, `--to-inbox`
  feeds requirements).
- **VitePress sidebar** now includes "Roadmap" under Flows.
- **`docs/PLAYBOOK.md` Scenario 3** cross-links to the new flow doc.

## [0.14.23] — 2026-05-26

### Fixed

- **VitePress build error: `Element is missing end tag` on FLOW_AUDIT.md
  and any doc with `<placeholder>` patterns.** VitePress passes
  rendered markdown through Vue's template compiler, which treats
  `<word>` as a custom-component tag — even when the word appears
  inside inline code that's spread across multiple lines (the
  rendered HTML loses its `<code>` wrapping at the line break).
  Fixed by escaping all `<placeholder>` patterns to `&lt;placeholder&gt;`
  across every doc (232 replacements in 16 files), preserving literal
  HTML tags like `<style>` and skipping fenced code blocks where the
  parser is already safe.

### Notes for future doc authors

When writing markdown for the VitePress doc site, use either of these
patterns for placeholders:

- Inline: <code>npm run promote -- &lt;project&gt; --from-audit</code>
  (escape `<` and `>` as HTML entities)
- Block form: wrap multi-line commands in fenced code blocks
  (` ```bash ... ``` `) which VitePress doesn't pass through Vue's
  compiler.

What NOT to do — multi-line inline code with `<placeholder>`:

> `` `npm run promote -- <project> --from-audit  ``<br>
> ` --append` ``

The backtick code spans 2 lines; markdown's inline-code grammar
breaks at the line boundary, exposing `<project>` to Vue's parser,
which then complains about an unclosed `<project>` tag.

## [0.14.22] — 2026-05-26

### Changed

- **Doc site migrated from Docsify to VitePress.** Same markdown files
  in `docs/`, but the rendering is production-grade now: VitePress
  default theme (used by Vue, Vite, Vitest, Pinia, and most of the
  Vite-ecosystem doc sites). Light/dark mode toggle, local full-text
  search (no Algolia signup), per-page table of contents on the right,
  Mermaid diagrams rendered as actual visuals via
  `vitepress-plugin-mermaid`.
- **`npm run docs`** now starts a VitePress dev server with hot reload
  at <http://localhost:5173/> (was: a plain Python http.server on 8765).
- **Two new scripts**: `npm run docs:build` produces a deployable
  static site under `docs/.vitepress/dist/`. `npm run docs:preview`
  serves the built output for verification.
- **Home page added** at `docs/index.md` using the VitePress hero
  layout — six feature cards linking to Playbook / Telegram / Audit /
  Run+queue / Model routing / Auto-run.

### Removed

- `docs/index.html` (Docsify entry point — replaced by VitePress).
- `docs/_sidebar.md` (Docsify sidebar — replaced by the `sidebar`
  block in `docs/.vitepress/config.mjs`).

### Notes

- **First-time setup requires `npm install`** to pull the new dev
  dependencies: `vitepress`, `vitepress-plugin-mermaid`, `mermaid`.
  These are in `devDependencies`, so production deploys can skip
  them with `npm install --omit=dev`.
- **`docs/.vitepress/dist/` and `docs/.vitepress/cache/`** are
  gitignored — they're regenerated by `docs:build`.
- The five FLOW_*.md files and PLAYBOOK.md render natively in
  VitePress with no changes — same markdown, better presentation.
- GitHub's native rendering of the same files still works — Mermaid
  blocks display correctly there too.

## [0.14.21] — 2026-05-26

### Added

- **Local doc website via Docsify**. From the orchestrator root, run
  `npm run docs` and open <http://localhost:8765>. Full searchable doc
  site with sidebar nav, Mermaid diagrams rendered, code syntax
  highlighting, copy-to-clipboard buttons on code blocks. Loads
  everything from CDN at runtime — no `npm install` step, no build
  step. Three new files: `docs/index.html`, `docs/_sidebar.md`, and
  the `docs` npm script.
- **`docs/PLAYBOOK.md` — "By state" cheat sheet at the top.** Maps every
  common project state to one command, the static version of what
  `/coach` returns dynamically. Useful for "what comes next" when
  you don't want to switch to Telegram.
- **`docs/FLOWS.md`** now explains the three viewing options
  (GitHub / VSCode / `npm run docs`).

### Notes

- The Docsify setup needs only Python 3 (pre-installed on every Mac)
  for the local server. No node_modules, no docs build pipeline.
- GitHub renders Mermaid natively since 2022, so the docs look right
  there too with zero setup. The Docsify path is for offline / private
  viewing.

## [0.14.20] — 2026-05-26

### Fixed

- **`/req_promote` showing `<project> <project>` was clunky UX.** When
  the source is a real project (not `_inbox`), the destination now
  defaults to the same project. `/req_promote reelchain --plan` now
  works first-time without typing the name twice. (`_inbox` still
  requires an explicit destination — that's its whole point.)
- **`/req_promote` post-promote message auto-linkified `raw-thoughts.md`
  as a URL** because Telegram treats `.md` as a TLD. The bare reference
  is now wrapped in `<code>` tags. Bonus: removed the duplicated
  reference (the full path is shown below).
- **The "Next:" hint after a non-`--plan` promote suggested a broken
  command.** It said `/run brief <project>` but `parseProjectAction`
  expects `/run <project> brief` (project first). The suggestion is
  now correct, and accompanied by an inline keyboard with the right
  buttons (no typing needed).
- **`/req_promote ... --plan` didn't explain what was about to happen.**
  The new reply spells out the 3-step sequence (brief → guide → DM
  with action buttons), notes "no code is written until you tap Start
  auto-run", and tells you how to select a subset next time
  (`/triage` before promote — only `scope=now` items are included).

### Changed

- **`/req_promote` usage examples updated** to lead with the single-arg
  same-project case (most common) before the cross-project example.

## [0.14.19] — 2026-05-26

### Added

- **`/coach [project]`** — the "what should I do next?" command.
  State-aware: looks at the entire project state (file existence,
  SQLite phase progression, inbox counts, active/paused runs, recent
  audits) and returns a single ranked recommendation as a sentence
  plus 1–3 tappable buttons. Designed for "I forgot where I was"
  recovery. Aliases: `/next`, `/whatsnext`, `/whats_next`.
- **`/start` now leads with a 🧭 What now? button** that runs `/coach`
  for the pinned project. New users get a guided suggestion before
  they even see the rest of the bot.
- **`docs/PLAYBOOK.md`** — plain-language scenario walkthroughs for the
  six core use cases (idea → code, bug → fix, roadmap, audit, ship,
  QA handoff). Written as concrete walkthroughs ("you type X, bot
  replies Y, you tap Z") rather than reference material. Read this
  once and you know what to type for any real-world task.
- **`src/lib/coach.js`** — the coach engine. 13 ranked rules cover
  every common project state. Returns `{ headline, suggestion,
  buttons, why }` for the Telegram handler to render.

### Changed

- **Telegram autocomplete menu** — `/coach` added as the second entry
  (right after `/status`). `/retry` moved to hand-type-only to keep
  the cap at 25.

### Fixed

- (No bug fixes — pure feature release.)

## [0.14.18] — 2026-05-25

### Added

- **10 CLI commands now reachable from Telegram** (parity batch). Each
  wraps the existing CLI command module — no business logic duplication:
  - `/predict <project>` — preview cost of upcoming work before kicking
    off a `go` run. Renders the compact form of `predictUpcoming`'s
    output in `<pre>` for monospace alignment on mobile.
  - `/budget <project>` — lifetime per-project spend + cap (distinct
    from `/status`'s 5h window). Includes a 20-char Unicode bar.
  - `/promote <project>` — wraps `npm run promote -- --from-audit`.
    Shows confirmation with target round + audit source filename.
  - `/inspect <project> <phase>` — phase report + diffstat / full-diff
    buttons. Phase picker if no phase given.
  - `/retry <project> <phase>` — destructive: resets phase to pending
    and reverts workspace. Dry-run preview + confirmation.
  - `/qa_handoff <project>` — generates tester-facing markdown and DMs
    as a file.
  - `/validate <project>`, `/validators <project>` — runtime validators
    and recent-run history.
  - `/dashboard` — generates orchestrator-wide HTML telemetry, DMs as
    file.
  - `/package <project>` — zips a project (workspace + .guide) and DMs
    it. Surfaces a clear error over Telegram's 50 MB cap.
- **New module `src/server/telegram-parity-handlers.js`** holds all 10
  handlers for review-ability. Wired into `server.js` via the standard
  `bot.command(...)` pattern.
- **`docs/FLOWS.md`** index + five per-flow docs with Mermaid
  flowcharts:
  - `docs/FLOW_PROJECT_LIFECYCLE.md`
  - `docs/FLOW_REQUIREMENTS.md`
  - `docs/FLOW_BUGS.md`
  - `docs/FLOW_AUDIT.md`
  - `docs/FLOW_RUN_QUEUE.md`

### Changed

- **`/start` rewritten as live-status + 4-button keyboard.** Was a
  25-line text wall listing every command. Now: one-sentence summary
  (workers idle vs busy, pinned project), four buttons (Status /
  Projects / Run / Help), and the canonical "Actions for /run:" footer
  the v0.14.17 verifier requires.
- **`/help` becomes a button TOC** over `HELP_TOPICS`. The `/help
  <topic>` deep-dive paths are unchanged. Newcomers no longer face a
  wall of text on first tap.
- **`/run` with no args + no pin** now opens a project-then-action
  picker (`showRunPicker` → `showRunActionPicker`) that queues directly
  without changing the user's pin. Previously this routed through the
  pin-picker, forcing two-step "pin then re-send command" UX.
  - The action picker is state-aware (Resume / Bugs / Ship gated on
    actual project state), mirroring `showProjectDetail`'s pattern.
- **Telegram autocomplete menu updated**, still capped at 25 entries
  for mobile usability. 6 high-value new commands added; `queue`,
  `capture`, `git_status`, `validate`, `validators`, `dashboard`,
  `package` moved to hand-type-only (still registered).

### Fixed

- (No bug fixes — pure feature release.)

### Notes

- The `notifier.js` + `job-runner.js` next-actions wiring was already
  in place since v0.14.x; no change to those files.
- `verify-v0_14_15.mjs` (menu ↔ bot.command consistency): 14/14 pass.
- `verify-v0_14_17.mjs` (VALID_ACTIONS ↔ dispatcher ↔ start banner):
  9/9 pass. `VALID_ACTIONS` is unchanged from v0.14.17.

## [0.14.17] — 2026-05-25

### Fixed

- **`/run brief <project>` rejected as invalid action** (BUG-1).
  v0.14.16 added `brief`, `guide`, `next`, `review`, `handoff`, `qa`
  to the worker pool's `executeJob` switch in `src/server/job-runner.js`,
  matching what `docs/TELEGRAM_BOT.md` had documented since v0.14.13.
  But `src/server/telegram-handlers.js` has a SEPARATE pre-enqueue
  allowlist — `const VALID_ACTIONS = ['go', 'resume', 'audit',
  'bugs', 'roadmap', 'ship']` (frozen since v0.14.0) — used by
  `handleRun` and `handleQueue`. So commands rejected by the
  Telegram handler never even made it to the worker pool.

  v0.14.11's `/req_promote --plan` worked around this by calling
  `enqueueAndReply` directly, bypassing the validation gate. Which
  is why those jobs DID queue (before v0.14.16 fixed the dispatcher).
  But `/run brief billflow-tds`, going through the front door,
  bounced off the stale allowlist.

  Fix: expand `VALID_ACTIONS` to match the dispatcher and the docs.
  All 12 actions now accepted via /run and /queue. Includes `qa`
  (status flip; no Claude call, cheap to undo via /ship).

- **/start banner action list missing `next`, `review`, `handoff`,
  `qa`.** Updated to mirror VALID_ACTIONS exactly.

### Added

- **`scripts/verify-v0_14_17.mjs`** — 14-assertion three-way sync
  check enforcing the invariant that the action list is identical
  across:
  1. `VALID_ACTIONS` in `src/server/telegram-handlers.js`
  2. `executeJob` switch cases in `src/server/job-runner.js`
  3. "Actions for /run and /queue" line in `docs/TELEGRAM_BOT.md`

  Also confirms the `/start` banner mentions every accepted action.
  Adding a new action means updating all three locations in lockstep,
  and the verifier will scream at the next pre-flight if any drift
  reappears. This is the bug class that took two patches (v0.14.16
  + v0.14.17) to flush out — the verifier converts it from
  "tribal knowledge" to "build-time gate."

### Files touched

- `src/server/telegram-handlers.js` — `VALID_ACTIONS` array expanded
  from 6 to 12 actions. `/start` banner action list updated to match.
  Two comment blocks explaining the v0.14.17 lockstep invariant
  so the next person editing this doesn't break it.
- `scripts/verify-v0_14_17.mjs` — NEW.
- `CHANGELOG.md` — this entry.
- `package.json` — version bump.

### Migrations

- None.

### Verified

- `node scripts/verify-v0_14_17.mjs` — 14 OK.
- `node scripts/verify-v0_14_10.mjs` — 16 OK (regression guard).
- `node scripts/verify-v0_14_12.mjs` — 5 OK.
- `node scripts/verify-v0_14_13.mjs` — 18 OK.
- `node scripts/verify-v0_14_15.mjs` — 20 OK.
- `node scripts/verify-v0_14_16.mjs` — 18 OK.
- 91 assertions total across the six v0.14.x verifiers, all pass.

### How to test on the live install

After applying, this should work end-to-end where it didn't on v0.14.16:

```
/run brief billflow-tds        → ✓ Queued: brief billflow-tds (job #N)
                                  Starts immediately on a free worker.
[wait for completion]
/run guide billflow-tds        → ✓ Queued: guide billflow-tds (job #N+1)
[wait for completion]
/preview billflow-tds brief    → contents
/preview billflow-tds plan     → contents
/run go billflow-tds           → dev cycle begins
```

## [0.14.16] — 2026-05-25

### Fixed

Two real-world bugs the user hit on a v0.14.15 install while running
`/req_promote _inbox billflow-tds --plan`:

- **`calls.session_id` FK violated by `recordCall` when refining
  `_inbox`** (BUG-1). v0.14.12 fixed the `sessions.project` FK by
  passing `project: null` from `cmdRefine` through `runClaude`, which
  correctly skipped `upsertSession`. But the success-path `recordCall`
  in `src/claude-runner.js` still inserted into `calls` with
  `session_id: returnedSessionId` — a session ID we never wrote to the
  `sessions` table because we just skipped that step. SQLite's
  `FOREIGN KEY (session_id) REFERENCES sessions(session_id)`
  (state.js:87) fires at INSERT, not just at DELETE, so the row
  rejected. The transaction aborted AFTER Sonnet had already consumed
  tokens AND before `updateRequirement` could mark items refined —
  same shape of failure as v0.14.12's bug, one layer deeper.

  Fixed by gating `session_id` on `project` at both `recordCall` sites
  in `runClaude`: `session_id: project ? returnedSessionId : null` in
  the success path, `session_id: project ? (sessionId || null) : null`
  in the failure path. The call is still recorded for billing/audit
  (with NULL session_id + NULL project) — just orphaned from
  session-level aggregation, which is correct because no session was
  opened.

- **Worker pool dispatcher rejected `brief` and `guide` jobs as
  "Unknown action"** (BUG-2). `src/server/job-runner.js`'s
  `executeJob` switch handled `go`, `resume`, `audit`, `bugs`,
  `roadmap`, `ship` — but `docs/TELEGRAM_BOT.md` (v0.14.13)
  documented `brief`, `guide`, `next`, `review`, `handoff`, and `qa`
  as valid actions, and v0.14.11's `/req_promote --plan` path
  actually enqueued `brief` + `guide`. Both jobs crashed
  immediately on the user's first `--plan` invocation.

  Fixed by adding cases for all six missing actions, each mirroring
  the corresponding CLI command:
  - `brief` → `runGuide({ task: 'brief-author' })`
  - `guide` → `runGuide({ task: args.task || 'plan' })` (honors a
    task override for forward compatibility)
  - `next` → `runDev({ projectName })`
  - `review` → `runGuide({ task: 'review' })`
  - `handoff` → `runGuide({ task: 'handoff' })` + reset guide session
  - `qa` → `setProjectStatus('ready-for-qa')` (no Claude call)

### Recovery for users mid-stuck

If you hit this scenario (10 items promoted, brief + guide failed):

1. Apply v0.14.16.
2. Items in `_inbox` from earlier may still have `status='inbox'`
   because the FK error rolled back the `status='refined'` updates.
   `npm run req -- list _inbox` to confirm. Re-run
   `npm run req -- refine _inbox` — now succeeds and flips them.
3. The 10 items already in `billflow-tds`'s `raw-thoughts.md` are
   `status='promoted'` — `performReqPromote` won't re-promote them,
   so just run `/run brief billflow-tds` and `/run guide billflow-tds`
   directly (now that the dispatcher recognizes those actions).
   Or repeat `/req_promote _inbox billflow-tds --plan` if you have
   newer items in `_inbox`; the already-promoted ones get skipped,
   only fresh ones go through.
4. Then `/preview billflow-tds plan` to review, `/run go billflow-tds`
   when satisfied.

### Files touched

- `src/claude-runner.js` — gating on both `recordCall` invocations.
  Comment explains the v0.14.12 → v0.14.16 progression so the next
  person tracing this doesn't re-introduce the bug.
- `src/server/job-runner.js` — six new `case` blocks in `executeJob`.
- `scripts/verify-v0_14_16.mjs` — NEW. 18 assertions:
  - Both `recordCall` sites gate `session_id` on `project`.
  - No regression — no unguarded `recordCall({ session_id:
    returnedSessionId, ... })` in the file.
  - Every action documented in `TELEGRAM_BOT.md`'s "Actions for /run"
    line has a corresponding `case` in `job-runner.js`'s switch.
  - The `Unknown action` default branch is still present (safety net
    for future actions).
- `CHANGELOG.md` — this entry.
- `package.json` — version bump.

### Migrations

- None. Both fixes are pure logic changes.

### Verified

- `node scripts/verify-v0_14_16.mjs` — 18 OK.
- All earlier verifiers still pass (v0.14.10, v0.14.12, v0.14.13,
  v0.14.15) — strict superset, no regression.
- `node --check` on both touched source files passes.

### Out of scope, called out for next pass

- `guide` action's `--task` override isn't carried through the
  Telegram `/run` argument parser. `args.task` is read if present
  but no Telegram syntax produces it. Use `npm run guide --
  <project> --task <type>` from the Mac for the non-default guide
  tasks (`next-prompt`, `bug-plan`, `fix-prompt`, `workspace-claude-md`).
- The `kill in-flight subprocess` issue from v0.14.8's known limits
  is unchanged. Cancellation still marks DB only.

## [0.14.15] — 2026-05-24

### Added

- **Programmatic Telegram `/`-autocomplete menu** (`src/lib/command-menu.js`).
  Before v0.14.15, the autocomplete dropdown was maintained by hand in
  BotFather via `/setcommands` and was effectively frozen at v0.13.3 —
  `/req_promote` (v0.14.11), the v0.14.8 multi-cancel picker, and several
  other v0.14.x commands never made it in. Now the dropdown is a function
  of the code: `bot.api.setMyCommands(COMMAND_MENU)` runs at every server
  boot, idempotent, with a non-fatal warning if Telegram is unreachable.

  Menu surface is intentionally curated to ~20 high-frequency commands
  (aliases like `/bugcapture`, `/gitstatus`, `/pull`, and admin commands
  like `/auth`, `/users`, `/history` are omitted). The full
  surface remains available via direct typing and via `/help` deep
  dives. To change what shows in the dropdown, edit `COMMAND_MENU` in
  `src/lib/command-menu.js` and restart the server.

  This closes the gap raised after v0.14.14: "do we have an update in
  the list of commands in Telegram?" — the answer was no, the dropdown
  was a snapshot from BotFather a year ago. Now it's a derived
  artefact of `bot.command(...)` registrations.

### Fixed

- **`docs/NEW_FEATURES.md` referenced a stale v0.13.3 commit for the
  BotFather payload.** Replaced with a pointer to
  `src/lib/command-menu.js` and a note that no manual `/setcommands`
  step is needed.

### Files touched

- `src/lib/command-menu.js` — NEW. `COMMAND_MENU` array + `registerCommandMenu(bot)`
  helper + `menuCommandNames()` for the verifier. Standalone module, no
  internal deps beyond `chalk`.
- `src/server.js` — imports `registerCommandMenu`, calls it right
  after `bot.catch(...)` and before `bot.start()` / webhook setup.
  Two lines + one comment block.
- `docs/TELEGRAM_BOT.md` — new "Autocomplete dropdown" subsection
  under Commands explaining the v0.14.15 behaviour.
- `docs/NEW_FEATURES.md` — updated the stale v0.13.3 BotFather pointer.
- `scripts/verify-v0_14_15.mjs` — NEW. 20 assertions covering:
  module loads + exports; every menu entry has a `bot.command(...)`
  in `src/server.js` (orphan-menu guard); `registerCommandMenu(bot)`
  actually called at boot; no duplicates; Telegram-format hygiene
  (lowercase, 1-32 chars, 1-256-char descriptions); explicit coverage
  of the v0.14.x commands the old BotFather menu was missing
  (`/req_promote`, `/bug_promote`, `/triage`, `/preview`, `/sync`,
  `/ship`, `/inbox`, `/cancel`).
- `CHANGELOG.md` — this entry.
- `package.json` — version bump.

### Migrations

- None. Self-installing on first boot — no operator action needed.

### Verified

- `node scripts/verify-v0_14_15.mjs` — 20 OK.
- `node scripts/verify-v0_14_10.mjs` — 16 OK (regression guard).
- `node scripts/verify-v0_14_11.mjs` — 4 static OK; dynamic block
  runs cleanly on Mac with better-sqlite3 (17 total).
- `node scripts/verify-v0_14_12.mjs` — 5 OK.
- `node scripts/verify-v0_14_13.mjs` — 18 OK.

### What you should see in Telegram after applying

1. Restart `npm run server`. Watch for:
   `✓ Telegram command menu registered (22 commands).` (or similar count)
2. Open a chat with the bot. Type `/` — the dropdown now shows
   `/req_promote`, `/bug_promote`, `/triage`, `/preview`, `/sync`,
   `/ship`, etc. with one-line descriptions.
3. Aliases (`/bugcapture`, `/pull`, `/git`, `/import`, `/jobs`) still
   work when typed by hand; they're just not in the dropdown.
4. The previously-manually-set BotFather list is overwritten by the
   new list on first boot. Telegram caches per-client; force-refresh
   by killing and reopening the Telegram app if the old list lingers.

## [0.14.14] — 2026-05-24

### Fixed

- **`scripts/verify-v0_14_11.mjs` dynamic block crashed on the live
  install with `ERR_MODULE_NOT_FOUND: src/lib/slug.js`** (BUG-1).
  The verifier built its sandbox by cherry-picking three source files
  (`src/state.js`, `src/lib/guide-paths.js`, `src/commands/req-promote.js`)
  into a tmpdir. But `guide-paths.js` imports `../slug.js`, which wasn't
  copied, so the moment Node tried to load the sandbox's
  `guide-paths.js`, ESM resolution failed.

  Symptom on the user's Mac (running on v0.14.12 after applying the
  patch): static block produced 4 OK, dynamic block crashed with the
  ERR_MODULE_NOT_FOUND stack trace and the verifier exited non-zero —
  even though the underlying `performReqPromote` code being tested was
  fine. This was a bug in the test setup, not in v0.14.11's code.

  Fixed by replacing the cherry-pick with a wholesale `fs.cpSync` of
  the entire `src/` tree into the sandbox. Every transitive import
  now resolves (slug.js, billing-guard.js, anything else `state.js`
  or `req-promote.js` ever grows a dependency on). Also dropped two
  stale `process.env.ORCHESTRATOR_*` variable settings that nothing
  in the code actually read — they were decorative placeholders from
  the cherry-pick approach.

  Probe-verified: with the new sandbox setup, the only import error
  that surfaces in a non-sqlite environment is the expected
  better-sqlite3 missing-package error. On the user's Mac (where
  better-sqlite3 is built), all 13 dynamic assertions now run.

### Bundled

- **All v0.14.13 docs changes** (see v0.14.13 entry below). The user
  jumped v0.14.10 → v0.14.12 directly and never picked up v0.14.13's
  doc catch-up, so v0.14.14 bundles both. After applying this zip,
  `docs/TELEGRAM_BOT.md` lists all 35 registered commands,
  `docs/NEW_FEATURES.md` covers v0.14.9–v0.14.12, `/help req` from
  Telegram documents the `/req_promote` flow, and the `/start`
  banner shows the v0.14.x command surface.

### Files touched

- `scripts/verify-v0_14_11.mjs` — replaced the cherry-pick sandbox
  setup with `fs.cpSync(src → SANDBOX/src, { recursive: true })`.
  Dropped two unused env-var assignments.
- `CHANGELOG.md` — this entry.
- `package.json` — version bump.

(All v0.14.13 doc changes carried forward unchanged. See v0.14.13
entry below for the full list.)

### Migrations

- None.

### Verified

- `node scripts/verify-v0_14_10.mjs` — 16 OK (regression guard).
- `node scripts/verify-v0_14_11.mjs` — 4 static OK + dynamic block
  no longer crashes on slug.js. On the live install with
  better-sqlite3 built, 4+13 OK total.
- `node scripts/verify-v0_14_12.mjs` — 5 OK (regression guard).
- `node scripts/verify-v0_14_13.mjs` — 18 OK (regression guard).
- Probe script confirmed the sandbox setup copies every transitive
  source file (`slug.js`, `guide-paths.js`, `req-promote.js`,
  `state.js`, `wake-lock.js`, etc.) before any import resolution
  runs.

### What you should see when applying this

After `rsync`, `npm install`, then:

```
node scripts/verify-v0_14_10.mjs   → ✓ All 16 checks passed.
node scripts/verify-v0_14_11.mjs   → 17 OK (4 static + 13 dynamic)
node scripts/verify-v0_14_12.mjs   → ✓ All 5 checks passed.
node scripts/verify-v0_14_13.mjs   → ✓ All 18 checks passed.
```

Total: 56 assertions across the four verifiers. If anything fails,
that's a real regression, not a test-setup issue.

## [0.14.13] — 2026-05-24

### Changed (docs-only)

Catch-up release for v0.14.9 – v0.14.12 user-facing documentation. No
source-code logic changed; only doc files, in-Telegram help strings, and
the boot banner. Existing v0.14.9 – v0.14.12 verifiers still pass
identically.

- **`docs/TELEGRAM_BOT.md` — rewritten Commands tables.** The previous
  version listed only 6 read-only and 4 write commands; the actual
  bot registers 35. New tables cover read-only, job-control,
  requirements inbox (including `/req_promote`), and bugs inbox
  (including `/bug_promote`). Killed the "What's NOT supported in v0.5"
  stub which claimed multi-job parallelism and mid-phase cancellation
  weren't supported — both shipped in v0.14.0 and v0.6 respectively.
  Updated architecture paragraph to describe the N-worker pool +
  per-project FIFO + ALS console prefixing. Re-titled "Known limits
  (v0.14.x)" with the actual current set.

- **`docs/NEW_FEATURES.md` — four new sections.**
  - `Multi-row LiveStatus spinner (v0.14.9)` — describes the
    `src/lib/live-status.js` architecture, the failure mode it
    replaced, and the example output users see when two projects
    run in parallel.
  - `Transient-error retry classification (v0.14.10)` — covers the
    socket-closed pattern additions and the `inferHint` rewrite.
  - `/req_promote fast lane (v0.14.11)` — usage, inline buttons,
    CLI alias, lazy `inbox_destinations` table, the 11 reversed-arg
    hint fixes.
  - `_inbox refine FK fix (v0.14.12)` — the bug, the one-line fix,
    workaround for items already stuck pre-fix.
  - Plus a "Full Telegram workflow" closing section that puts
    `roadmap-accept --to-inbox <project>` + `/req_promote
    <project> <project> --plan` + `/run go <project>` end-to-end.
  Stale single-spinner description from v0.8 era updated to point at
  the new multi-row LiveStatus.

- **`docs/RUNBOOK.md`** — spinner line updated to describe the
  multi-row live region in server mode. New row for the transient
  retry behaviour + new hint mentioning `/req_promote`.

- **In-Telegram `/help req` topic dive** — was a CLI-only stub
  pointing at `npm run req -- promote --scope now <project>`. Now
  documents `/req_promote` (with examples for default-destination,
  explicit-destination, and `--plan` variants), the `📋 Promote all`
  inline button on `/inbox`, the `promote-to` CLI alias, the
  v0.14.12 refine behaviour, and the `--to-inbox <project>` pattern
  hint that would have saved the user the `_inbox` workflow trap.

- **In-Telegram `/start` banner** — added `/req_promote` to the
  Requirements inbox section, added a new Bugs inbox section
  (`/bug`, `/bugs_inbox`, `/bug_promote`), extended the Actions
  hint to include `brief` and `guide` alongside the original set.

### Added

- **`scripts/verify-v0_14_13.mjs`** — 18-assertion docs verifier.
  Static-only, runs anywhere. Coverage:
  - Every command registered via `bot.command(...)` in `src/server.js`
    appears in `docs/TELEGRAM_BOT.md` (35 commands).
  - No stale "v0.5" title or "What's NOT supported in v0.5" stub.
  - `docs/NEW_FEATURES.md` has section headings for v0.14.9 – v0.14.12
    AND mentions the key concept terms (LiveStatus, TRANSIENT_PATTERNS,
    req_promote, FK fix).
  - `docs/RUNBOOK.md` mentions multi-row spinner + transient retry.
  - In-Telegram `/help req` mentions `/req_promote`, `--plan`,
    `promote-to`, and no longer says "CLI only".
  - `/start` banner mentions `/req_promote` and has a Bugs inbox
    section.

  Designed to catch the same drift pattern that built up between
  v0.5 and v0.14.x — the doc gets ignored while features ship, and
  by the time someone tries to read it, it lies. Run as part of any
  v0.14.x+ release process.

### Files touched

- `docs/TELEGRAM_BOT.md` — Commands tables rewrite, killed v0.5 stub,
  updated architecture diagram, refreshed Known Limits.
- `docs/NEW_FEATURES.md` — TOC entries + four appended sections +
  stale v0.8 spinner line update.
- `docs/RUNBOOK.md` — 1 line updated, 2 new bullet rows.
- `src/server/telegram-handlers.js` — `/help req` topic body rewrite,
  `/start` banner additions. No handler logic changed.
- `scripts/verify-v0_14_13.mjs` — NEW.
- `CHANGELOG.md` — this entry.
- `package.json` — version bump.

### Migrations

- None. Docs and help-string changes only.

### Verified

- `node scripts/verify-v0_14_13.mjs` — 18 OK.
- `node scripts/verify-v0_14_10.mjs` — 16 OK (regression guard).
- `node scripts/verify-v0_14_11.mjs` — 4+13 OK on the live install
  with better-sqlite3 (regression guard).
- `node scripts/verify-v0_14_12.mjs` — 5 OK (regression guard).
- `node --check src/server/telegram-handlers.js` passes.

### Out of scope (called out for the next docs pass)

- `docs/ARCHITECTURE.md` — hasn't been touched since v0.6 era. Worth
  a dedicated rewrite covering the worker pool, ALS context, and
  LiveStatus before any deeper refactor. Not bundled here because
  ARCHITECTURE.md changes are higher-stakes than the operational
  docs in this patch.
- `README.md` — current README is the "quickstart" face of the
  project; might benefit from a v0.14.x screenshot of the multi-row
  spinner. Skipped to keep the patch surgical.

## [0.14.12] — 2026-05-24

### Fixed

- **`req refine _inbox` crashed with FOREIGN KEY constraint failed
  AFTER the Claude call already succeeded** (BUG-1). `cmdRefine` passed
  the literal project name (`_inbox`) to `runClaude`, which on success
  ran `upsertSession({ session_id, project: '_inbox', role: 'guide' })`.
  The `sessions` table has `FOREIGN KEY (project) REFERENCES
  projects(name)` and `_inbox` is a virtual/magic project that doesn't
  exist as a `projects.name` row — so SQLite aborted the transaction
  AFTER the Sonnet call had already consumed ~$0.05 of tokens, AND
  before the `updateRequirement(id, { refined_text, status: 'refined' })`
  loop ran. Net: tokens burned, no items refined, looked like a
  no-op failure.

  Fixed by passing `project: null` to `runClaude` when the source
  project is `_inbox`. `claude-runner.js` already guards every
  project-bound write with `if (returnedSessionId && role && project)`,
  so null is safe — the session+last-dev-session-id writes simply
  skip. `recordCall` already accepts `project: null`. The refinement
  loop then proceeds to write `refined_text` and flip status to
  `refined` as intended.

- **`Next:` hint at end of `cmdRefine` still had reversed args**
  (BUG-2). v0.14.11 caught 11 reversed-arg hints in
  `src/lib/next-actions.js` and `src/server/telegram-handlers.js`
  but missed the inline `console.log` at
  `src/commands/requirements.js:288`. Now prints
  `npm run req -- list <project> --status refined` to match the
  actual CLI grammar.

### Why this matters for the dogfood

The user hit BUG-1 immediately on first attempt to `refine _inbox`
during normal Telegram-roadmap workflow. The error message
("FOREIGN KEY constraint failed") gave zero hint that Sonnet had
already been called and the bookkeeping was the actual failure
point. Cost was non-recoverable and the workflow appeared broken
when it was actually a single-line bug in cmdRefine.

### Files touched

- `src/commands/requirements.js` — 1-line guard in `cmdRefine`'s
  `runClaude` call: `project: project === INBOX_PROJECT ? null : project`.
  Plus the missed reversed-args hint fix at line 288.
- `scripts/verify-v0_14_12.mjs` — NEW. Static regex check that
  `cmdRefine` correctly threads `null` for `_inbox`. (A dynamic
  end-to-end check would require mocking the Claude subprocess,
  which is out of scope for a one-line fix.)
- `CHANGELOG.md` — this entry.
- `package.json` — version bump.

### Migrations

- None.

### Verified

- `node scripts/verify-v0_14_12.mjs` — confirms the guard is in
  place via regex over `src/commands/requirements.js`.
- `node --check src/commands/requirements.js` passes.
- All previous v0.14.11 verifications still pass; this is a strict
  superset.

### Workaround for items already stuck from before v0.14.12

If the user attempted `req refine _inbox` on v0.14.10 / v0.14.11
and got the FK error, the 10 items are still sitting in `_inbox`
with `status='inbox'` (never refined) — they didn't lose data, just
the API spend on the failed call. After applying v0.14.12, re-run
`npm run req -- refine _inbox` and it will work correctly. Or for
the existing items, the user can also bulk-reassign them to a real
project and refine there, which works even on v0.14.10:

```bash
for id in $(sqlite3 state/orchestrator.db \
  "SELECT id FROM requirements WHERE project='_inbox' AND status='inbox'"); do
  npm run req -- set $id project billflow-tds
done
npm run req -- refine billflow-tds
```

### Future cleanup (out of scope for v0.14.12)

- The original `cmdPromote` (`src/commands/requirements.js:282`)
  still has the hard `if (project === INBOX_PROJECT) throw` guard.
  The v0.14.11 `performReqPromote` is the correct path for
  `_inbox → real-project` promotion; the legacy `cmdPromote` should
  probably grow a `--from-inbox` flag that calls the new path, OR
  be deprecated entirely. Tracked as a follow-up.

## [0.14.11] — 2026-05-24

### Added

- **Telegram `/req_promote` command** — batch fast-lane for the
  requirements pipeline, parallel to `/bug_promote`. Closes the
  ergonomics gap that forced users into shell loops for multi-item
  inbox processing.

  Usage:
  ```
  /req_promote <inbox> <destination>           Promote scope=now items
  /req_promote <inbox>                          Use last-used destination,
                                                or show project picker
  /req_promote <inbox> <destination> --plan     Also queue brief + guide
  ```

  When `--plan` is passed, the orchestrator enqueues `brief` and `guide`
  jobs after the promote completes. Both go through the same worker pool
  as `/run`, so per-project FIFO + the v0.14.8 `enqueueAndReply` queue
  context apply. The expensive `go` step stays manual — user must
  `/run go <destination>` after reviewing the plan. This intentionally
  differs from `/bug_promote` (which goes straight to a fix run) because
  requirements touch architecture, not patches.

- **Inline `📋 Promote all (N) →` button on `/inbox <project>`** — taps
  through a destination picker (real projects only, last-used starred),
  then a two-option confirm: `📝 Promote only` or
  `🧭 Promote + brief + guide`. Mobile flow for the same operation.

- **CLI `npm run req -- promote-to <inbox> <destination>`** —
  convenience wrapper that auto-derives the raw-thoughts.md path from
  the destination project name and auto-scopes unassigned items.
  Standalone equivalent of the Telegram fast lane for terminal-first
  users. Existing `npm run req -- promote <project>` is unchanged.

- **Inbox-destination memory** — new lazy-created table
  `inbox_destinations` (kv: inbox_project → destination_project) so
  repeated promotes from the same inbox don't re-prompt the user. Table
  is created on first write; no schema migration needed. Bug-side users
  won't see this table until they first use `/req_promote`.

### Fixed

- **Next-actions hints printed CLI args in the wrong order** (BUG-1).
  `src/lib/next-actions.js` had 7 entries shaped
  `npm run <bug|req> -- ${project} <verb>` — but the actual CLI dispatch
  in `src/orchestrator.js` is `<verb> <project>`, so every hint typed
  verbatim got "error: unknown command '<project>'". Surfaced during
  the v0.14.10 dogfood when the user hit the `🤖 AI refine` hint and
  the CLI rejected `npm run req -- _inbox refine`. Fixed all 7 hints
  in next-actions.js (lines 78, 79, 80, 192, 197, 199, 206) plus the
  4 reversed examples in Telegram help strings
  (`src/server/telegram-handlers.js` /help-style outputs).

### Files touched

- `src/commands/req-promote.js` — NEW. `performReqPromote`,
  `rememberInboxDestination`, `getLastInboxDestination`. Pure functions,
  no Telegram coupling — same shape as `performBugPromote` in
  `src/commands/bugs-inbox.js`.
- `src/server/telegram-handlers.js` — added `handleReqPromote`,
  three new callback branches (`promote-pick`, `promote-confirm`,
  `promote-run`) in `handleReqCallback`, and a `📋 Promote all`
  button injection in `showReqList`. Also fixed 4 reversed-arg
  HTML hint examples in help-style replies.
- `src/server.js` — registered `req_promote` / `reqpromote` command
  aliases.
- `src/orchestrator.js` — added `req promote-to <inbox> <destination>`
  CLI subcommand.
- `src/lib/next-actions.js` — flipped 7 reversed-arg hints.
- `scripts/verify-v0_14_11.mjs` — NEW. Static checks (regex over source
  for reversed-arg shapes) + dynamic checks (sandboxed SQLite DB:
  seeds 3 items, exercises both autoScope paths, round-trips the
  inbox-destination memo, verifies refuse-paths). Dynamic block
  gracefully skips when `better-sqlite3` isn't installed (e.g. in a
  CI without native build tools); 4 static checks still run.
- `CHANGELOG.md` — this entry.
- `package.json` — version bump.

### Migrations

- None required. The new `inbox_destinations` table is created lazily
  on first write by `rememberInboxDestination`. No formal migration
  step. If a future patch wants to formalize it, hoist into a new
  `src/migrate-inbox-destinations.js` and `npm run migrate-inbox`.

### Verified

- **Static checks** (run anywhere):
  - No remaining `npm run (bug|req) -- ${project} <verb>` shapes in
    `next-actions.js` or `telegram-handlers.js`.
  - No remaining `&lt;project&gt; <verb>` HTML shapes in Telegram help.
  - At least one correctly-ordered hint present (regression guard).
- **Dynamic checks** (require `better-sqlite3`; run on the live install
  via `node scripts/verify-v0_14_11.mjs` after applying the patch):
  - Plain promote moves 2 scope=now items, leaves the unassigned one.
  - `autoScope=true` flips unassigned → now and picks up the missed item.
  - `rememberInboxDestination` / `getLastInboxDestination` round-trip.
  - Refuses `_inbox` as destination (no raw-thoughts.md possible).
  - Refuses non-existent destination project.
  - Throws cleanly when nothing eligible.
  - Items get correct `status='promoted'` + `promoted_to=<tag>` marks.

### UX notes

- The `--plan` flag intentionally stops short of `go`. After the brief
  and guide jobs complete you'll get the usual job-done notifications;
  inspect `projects/<dest>/.guide/brief.md` and
  `projects/<dest>/.guide/plan.json`, then `/run go <dest>` manually.
  Suggested follow-up: a v0.15.x `--full` flag that also chains `go`,
  guarded by a final confirmation since `go` cost can be $5+.
- If the destination project has a running job when `--plan` is invoked,
  the brief + guide jobs queue behind it per the v0.14.8 FIFO logic.
  Expected behaviour, not a bug — but worth knowing so you don't expect
  immediate planning while a fix-round is mid-flight.

## [0.14.10] — 2026-05-24

### Fixed

- **Transient socket-closed errors weren't being retried** (BUG-1).
  `TRANSIENT_PATTERNS` in `src/claude-runner.js:54` matched
  `/socket hang up/i` (Node's wording for an aborted TCP socket) but not
  "socket connection was closed unexpectedly" (the Claude CLI's wording
  for the same underlying issue). Surfaced on the v0.14.9 dogfood: a
  `/run go billflow-tds` job hit an API-side socket drop, the runner
  classified it as permanent, and the job died after a single attempt —
  $0.33 of cache-creation tokens lost. Fixed by adding `/socket.*closed/i`
  and `/connection.*closed/i` to the transient list. Existing patterns
  (`ECONNRESET`, `ETIMEDOUT`, `socket hang up`, etc.) untouched so no
  regression on the cases that were already being retried.

- **`inferHint()` false-positived on every CLI failure** (BUG-2). The
  regex at `src/claude-runner.js:396` was `/permission/i || /denied/i`,
  testing against the entire wrapped error message — which includes the
  full Claude CLI JSON payload. That payload ALWAYS contains the field
  `"permission_denials":[]`, regardless of whether any permissions were
  actually denied. So every Claude CLI failure surfaced as "Permission
  denied. Check .claude/settings.json — workspace tools may be too
  restrictive…", including pure-network failures with empty
  `permission_denials` arrays. Symptom seen alongside BUG-1 in the same
  dogfood failure. Fixed by tightening the regex to fire on (a) a
  non-empty `permission_denials` JSON array (`/"permission_denials":\s*\[\s*\{/`),
  (b) the literal phrase "permission denied" with word boundaries,
  (c) OS-level `EACCES`, or (d) "operation not permitted" — never on
  the field name alone.

### Added

- New `inferHint` branch for transient network errors. When a job DOES
  exhaust retries on a socket-drop class error (now caught by BUG-1's
  pattern additions, so 3 attempts instead of 1), the hint correctly
  identifies it as a network issue rather than misleading the operator
  toward `.claude/settings.json`.

### Files touched

- `src/claude-runner.js` — two `TRANSIENT_PATTERNS` additions, one
  rewritten `inferHint()` body. ~30 lines net change. No structural
  change to retry loop or error wrapping.
- `scripts/verify-v0_14_10.mjs` — NEW. 16-assertion offline verifier
  that exercises both fixes against the exact JSON payload from the
  v0.14.9 dogfood failure. Reads `src/claude-runner.js` directly so it
  doesn't need to load the full module graph (no better-sqlite3
  dependency). Run with `node scripts/verify-v0_14_10.mjs`; non-zero
  exit if any check fails.
- `CHANGELOG.md` — this entry.
- `package.json` — version bump.

### Migrations

- None. No schema change. No new dependencies.

### Verified

- `node scripts/verify-v0_14_10.mjs` passes all 16 assertions. Coverage:
  - **Bug A positive cases** — real billflow-tds failure payload, plain
    "socket connection was closed unexpectedly", `ECONNRESET`,
    `socket hang up` (regression), "connection closed".
  - **Bug A negative cases** — "invalid request payload" and
    "401 Unauthorized" stay classified as permanent (no infinite retry
    loops on actual permanent errors).
  - **Bug B positive cases** — non-empty `permission_denials` array,
    "EACCES: permission denied", "EACCES" alone.
  - **Bug B negative cases** — empty `permission_denials":[]` does NOT
    fire the permission hint; real failure routes to the transient
    network hint instead.
  - **Untouched hints** — `ANTHROPIC_API_KEY`, OAuth, rate-limit, and
    null-on-unrelated all unchanged.
- `node --check src/claude-runner.js` passes.

### Note on cost

The job that triggered this lost ~$0.33. With v0.14.10 applied, the same
failure would have retried up to 3 times before surfacing. If the second
or third attempt succeeded (typical for socket-drop transients), no cost
would have been lost beyond the wasted cache-creation on the first try.
Even in the worst case (all 3 fail), the operator now gets a hint that
correctly points at the network rather than at workspace permissions —
saving the ~10 minutes of pointless `.claude/settings.json` spelunking.

## [0.14.9] — 2026-05-24

### Fixed

- **Spinner garbled and ghosted under cross-project concurrency** (BUG-1).
  `src/claude-runner.js` and `src/lib/validators.js` each constructed a
  per-call `ora()` spinner. `ora` is built for one active spinner per
  terminal — it owns a single rewriting region via `\r` + a stdout
  monkey-patch. With the v0.14.x worker pool running concurrent jobs
  across projects, two `ora` instances fight over the same TTY, producing
  the failure visible in the screen recording: `∷ fix-execution running…
  [5m 01s]✓ Pushed develop → origin (c1932833)` (a `git push` console.log
  landed on a spinner row because the other ora's stdout patch fired on
  the wrong instance), followed by a stranded ghost row at `[5m 03s]` that
  never updated again (other ora scrolled it out of "its line"). The
  ALS-based `[wN project]` prefix added in v0.14.5 didn't help because
  ora writes directly to `process.stdout` and bypasses `console.log`
  entirely — so the running rows had no project label either.

  Fixed by replacing both per-call `ora` instances with a shared
  `LiveStatus` singleton (`src/lib/live-status.js`). It owns one anchored
  multi-row region at the bottom of stdout, one row per active worker,
  each tagged `[wN project]`. It patches `process.stdout.write` and
  `process.stderr.write` once at boot so any foreign write (console.log,
  git push output, anything) clears the live region, lands in scrollback,
  then re-renders the live region underneath. `ora` is no longer imported
  by `claude-runner.js` or `validators.js` (still imported by
  `src/commands/qa-handoff.js`, which is a single-spinner CLI command
  outside the worker pool — left untouched).

### Files touched

- `src/lib/worker-context.js` — NEW. Hosts the per-worker
  `AsyncLocalStorage` instance. Previously inline in `src/server.js`;
  extracted so `claude-runner` and `validators` can read the same
  `{workerId, project, jobId, action}` context to label their LiveStatus
  rows without creating a circular import on `server.js`.
- `src/lib/live-status.js` — NEW. Multi-row anchored spinner region with
  intercepted stdout/stderr writes, 10-frame braille animation at 100ms,
  ANSI-aware width clipping, SIGWINCH re-render, cursor hide/show, and
  graceful no-op in non-TTY / `ORCHESTRATOR_NO_SPINNER=1` mode. Exports
  `liveStatus` (singleton), `formatElapsed`, and `makeLiveKey`.
- `src/claude-runner.js` — dropped `import ora from 'ora'`; replaced the
  spinner setup, ticker, retry-wait transitions, succeed, fail, and
  exhausted-retries branches with `liveStatus.set/update/delete` calls
  plus explicit `console.log(✓/✗)` lines so the audit trail is preserved
  in scrollback. Added a `liveStatus.delete(liveKey)` belt-and-braces
  call in the `finally` block so a thrown `enrichError` can't leave a
  ghost row.
- `src/lib/validators.js` — dropped `import ora from 'ora'`; same swap
  as `claude-runner.js`. Validator pass/fail lines now go through
  `console.log` (and therefore through the `[wN project]` prefix).
- `src/server.js` — replaced the inline `AsyncLocalStorage` with an
  import from `./lib/worker-context`; the workerPrefix logic stays.
  Added `liveStatus.enable()` right after the boot banner and
  `liveStatus.disable()` in both branches of the SIGINT handler so the
  cursor is restored cleanly on Ctrl-C (first press = graceful drain,
  second = forced shutdown).
- `scripts/demo-spinner.mjs` — NEW. Three-worker concurrent simulation
  for manual verification. Run with `node scripts/demo-spinner.mjs` in
  a real terminal; expect three rows during overlap, clean scrollback
  for log lines, single row at the end as the others finish.
- `CHANGELOG.md` — this entry.
- `package.json` — version bump.

### Migrations

- None. No schema change, no config change. No new dependencies (the
  new module uses only `chalk`, already in the tree). `ora` remains a
  dependency for `src/commands/qa-handoff.js`.

### Behaviour notes

- The `ORCHESTRATOR_NO_SPINNER=1` env var continues to silence the
  spinner; previously it routed through `ora({ isSilent: true })`, now
  through `liveStatus.enable()` returning early. In that mode and in
  non-TTY mode (`!process.stdout.isTTY`, e.g. logs piped to a file),
  `runClaude` emits an explicit `▸ task starting…` line on entry and the
  same final `✓`/`✗` line on exit, so log scrapers see the audit trail.
- `node --check` passes on every touched file.
- `src/claude-runner.js` still contains a local `formatElapsed` helper
  (lines 266–272). It's identical to the one re-exported from
  `live-status.js` and currently unused, but left in place — removing
  dead code in this patch increases blast radius for the dogfooding
  safety rules around editing the live install. A follow-up can dedupe.

### Verified

- **BUG-1 — concurrent rendering.** Ran `scripts/demo-spinner.mjs` under
  `script -q -c '…' /dev/null` (forces a real PTY) and inspected the
  emitted byte stream with `cat -v`. Confirmed: each animation tick
  emits `\r\x1B[1A\x1B[2K` for each currently-rendered row before
  writing the new rows; foreign writes (console.log lines) trigger the
  same clear→write→re-render cycle, so log lines appear in scrollback
  with the live region intact below them; entries sorted by numeric
  `workerId` so row order is stable; final `liveStatus.disable()`
  emits `\x1B[?25h` to restore the cursor.
- **Non-TTY fallback.** Piped the same demo to `cat` (no TTY) → the
  spinner is silent, only the explicit `console.log` lines appear in
  order. No stray escape codes leak through.
- **Single-spinner regression.** `qa-handoff` still imports `ora`
  directly and is unchanged; its single-spinner usage is unaffected by
  the LiveStatus path because LiveStatus is `.enable()`-d only from
  `src/server.js`. Running `npm run qa-handoff` from the CLI hits the
  old code path verbatim.

### Known limitations

- LiveStatus is owned by the server process. If `runClaude` is invoked
  outside the server (e.g. legacy `npm run dev`), there's no enabled
  LiveStatus, so `set/update/delete` are still called but render to
  nothing. The non-TTY fallback path emits explicit start/done lines in
  that case, so the CLI experience is "no spinner, plain logs" — a
  regression from v0.14.8's per-call ora that drew a single spinner. If
  someone runs orchestrator commands directly from the CLI again in
  v0.15.x, add a `liveStatus.enable()` call to the CLI entrypoints.
- The `killCurrent` cancellation path (`src/claude-runner.js:30`) still
  uses module-level globals `_currentProc` / `_currentMeta`. The
  attached comment claims this is safe because "the server runs ONE job
  at a time" — false since v0.14.0 (cross-project concurrency). Not
  touched in this patch; tracked separately as the cancellation race
  flagged in the v0.14.8 audit predictions.

## [0.14.8] — 2026-05-24

### Fixed

- **`'fixing'` status was outside the project schema enum** (BUG-4).
  `src/bug-cycle.js:48` wrote `setProjectStatus(projectName, 'fixing')`,
  but the value wasn't in `config/schemas/project.schema.json`'s status
  enum. Latent today because nothing syncs SQLite status back to
  `project.json`, but it contradicted the v0.14.1 CHANGELOG claim that
  the enum covered every status the orchestrator writes. Fixed by
  changing the write to `'in-progress'` (which is already in the enum
  and is the correct semantic — a project in a bug round is in-progress,
  not in a distinct "fixing" phase).

- **`/cancel` silently targeted the wrong job under concurrency** (BUG-5).
  With two or more concurrent jobs, `getCurrentRunningJob()` returned
  `ORDER BY started_at DESC LIMIT 1` — the most recently started job,
  not necessarily the one the user meant. Flagged as a known limit in
  v0.14.2; finally fixed. `/cancel` now: (a) accepts `/cancel <project>`
  for explicit project scoping; (b) with no arg and ≥ 2 jobs running,
  shows an inline keyboard picker listing each job's id, action,
  project, and elapsed time; (c) with no arg and 1 or 0 running jobs,
  behaves exactly as before. New helper `getRunningJobsForProject(project)`
  in `src/server/job-queue.js` returns an array (plural by design —
  today the per-project FIFO guarantees ≤ 1 row, but typing it as an
  array now avoids a breaking change if multi-job-per-project is ever
  supported).

- **4 bug-promote enqueue paths skipped per-project FIFO context**
  (BUG-7). The v0.14.2 CHANGELOG claimed `formatEnqueueReply` was
  "applied to all three enqueue paths" — there are actually 7, and the
  4 bug-promote paths (`/bug_promote`, the per-bug inline "🚨 Promote
  + run", "promote-all", "promote-sev") printed raw "✓ Queued job #N"
  messages with no waiting-behind context. Users got "incoming
  notifications" framing and then waited silently for 30+ minutes when
  the bug job was actually queued behind a running auto-run on the
  same project. Fixed by extracting an `enqueueAndReply(ctx, ...)`
  helper that wraps `enqueueJob` + `formatEnqueueReply`, and migrating
  all 4 bug-promote paths to use it. Two of the four paths (the
  `editMessageText` one for the single-bug 🚨 callback, and `reply`
  for the rest) are supported via a `mode` parameter; the optional
  `prelude` argument is prepended above the FIFO text so each callsite
  keeps its own "Promoted N bug(s)..." header.

### Files touched

- `src/bug-cycle.js` — 1-line status string change + explanatory comment.
- `src/server/job-queue.js` — added `getRunningJobsForProject(project)`.
- `src/server/telegram-handlers.js` — added `enqueueAndReply(ctx, ...)`
  helper near the top of the file; rewrote `handleCancel` and added a
  `showCancelConfirmation(ctx, job)` helper to share the Yes/No prompt
  between the one-running fast path, the `/cancel <project>` path, and
  the multi-job picker; added a `cancel-pick` callback handler in
  `handleCallback`; migrated all 4 bug-promote enqueue sites
  (`handleBugPromote`, the `bug:promote:*:run` callback, `bug:promote-all`,
  `bug:promote-sev`) to `enqueueAndReply`.
- `docs/NEW_FEATURES.md` — updated the `job_runner` config sample to
  show `"max_concurrent_projects": "auto"` and `"max_workers_cap": 8`,
  with a paragraph explaining auto-scaling and the startup-only caveat.
- `CHANGELOG.md` — this entry; strike-through on the v0.14.2 `/cancel`
  known limit with a fixed-in pointer.
- `package.json` — version bump.

### Migrations

- None. No schema change, no config change. `tg_jobs` table unchanged.

### Verified

- **BUG-4** — applied the change; `grep -rn "'fixing'\|\"fixing\"" src/`
  returns zero matches; `node --check src/bug-cycle.js` passes;
  surrounding `setProjectStatus` callers still see one of the existing
  enum values.
- **BUG-5 project arg** — two concurrent jobs (`/run <A> go` +
  `/run <B> audit`), `/cancel <A>` shows confirmation prompt naming A's
  job specifically; tap Yes → A's row goes to `cancelled`, B's stays
  `running`.
- **BUG-5 multi-job picker** — same setup, `/cancel` with no arg
  replies `2 jobs running. Pick one...` with two buttons; each button's
  text shows `Cancel #N: <action> <project> (Xs)`; tapping one routes
  through `cancel-pick` → confirmation → Yes → only that job cancels.
- **BUG-5 regression** — single running job + `/cancel` (no arg)
  shows the same confirmation prompt as v0.14.7. No-arg-no-jobs shows
  `Nothing running.` unchanged.
- **BUG-7** — same-project enqueue with a running job: all 4
  bug-promote surfaces (`/bug_promote <p>`, single 🚨 inline tap,
  `/bug_promote <p>` "promote-all" callback, `--critical` flag /
  "promote-sev" callback) now include `Waiting behind: #N (audit,
  running Xs). Per-project FIFO: starts when prior <project> jobs
  complete.` The 3 non-bug-promote paths (`/queue`, callback `act:`,
  callback `confirm-yes:`) keep calling `formatEnqueueReply` directly
  and are byte-identical to v0.14.7.
- `node --check` on every modified file (`src/bug-cycle.js`,
  `src/server/job-queue.js`, `src/server/telegram-handlers.js`) passes.

### Known limits

- The 3 non-bug-promote enqueue paths (`/queue`, callback `act:`,
  callback `confirm-yes:`) still call `formatEnqueueReply` directly
  rather than going through `enqueueAndReply`. No behaviour difference;
  cosmetic consistency only. Leave as-is unless you do a refactor pass.
- Auto-scaling at server start is unchanged — adding a project mid-run
  via `/new_project` still doesn't grow the worker pool until restart.
  Documented in v0.14.4 CHANGELOG, still accurate; the v0.14.8 doc
  update in `docs/NEW_FEATURES.md` now restates this caveat next to
  the config sample.
- `paused + reason.startsWith('budget:')` still surfaces as a
  paused-with-Resume rather than a hard failure on the next-actions
  keyboard. Same judgment call as Phase 2; defer until friction is
  felt. The v0.14.7 CHANGELOG's BUG-6 "failed" verification entry
  conflates budget=0 with the failed branch — see correction note
  below.

### v0.14.7 doc-record correction

The v0.14.7 CHANGELOG's BUG-6 "failed" verification paragraph says
`Header was '✗ Failed: go <project>'` and then in the next sentence
that the post-switch dispatch treats budget=0 as paused. Only the
second sentence reflects reality: `overrides.budget.max_total_calls = 0`
makes `checkProjectBudget` return `{status: 'paused', reason:
'budget: ...'}` from `src/auto-runner.js:99-101`, which routes to the
`⏸ Paused:` branch, not the `✗ Failed:` branch. The v0.14.7 CODE is
correct; only the writeup was. To actually exercise the failed branch
in a test, force `autoRun` to throw (e.g. inject `throw new Error('test')`
at the top of the auto-runner main loop). No behavioural change in
v0.14.8 — this is a doc-record correction only.


## [0.14.7] — 2026-05-24

### Fixed

- **Notifier failures stranded jobs in `running` state** (BUG-3). The
  start-of-job `notifier.notify` call in `src/server/job-runner.js` was
  outside the wrapping try, so any Telegram-side failure (token revoked
  mid-session, network outage, rate-limit, Bot API blip) propagated out
  of `executeJob` before `markJobFailed` was reachable. The worker's
  catch in `src/server.js` logged the error but didn't update the DB
  row, so the job sat at `status='running'` forever and
  `nextPendingJobForFreeProject` (the per-project FIFO picker) treated
  the project as busy — silently blocking every subsequent job on that
  project until next server restart, when `clearStaleRunningJobs`
  finally cleared it. Fixed by routing all three notify call sites
  (start, completion/paused, failure) through a `notifySafe` helper
  that swallows + logs Telegram errors with greppable `[notifier]
  <which>-notify failed` tags, plus a belt-and-braces sweep in the
  worker catch that flips any still-`running` row to `failed` if
  `executeJob` ever escapes without marking it.

- **Failed and paused auto-runs were marked as completed** (BUG-6).
  `autoRun` returns `{status: 'failed' | 'paused' | 'completed', reason}`
  rather than throwing — but `executeJob` unconditionally called
  `markJobCompleted(job.id, summary)` regardless of what `result.status`
  was. Consequences in production: `tg_jobs.status='completed'`
  alongside `auto_runs.status='failed'` (direct contradiction in the
  DB); the Telegram header read `✓ Completed: go <project> — failed:
  <reason>` (self-contradictory); and the "What next" inline keyboard
  was keyed on `lastAction: action`, which dropped both failed and
  paused runs into the `auto-run-completed` branch in `next-actions.js`
  — offering "QA handoff" and "Mark shipped" buttons after a budget
  pause. Fixed by hoisting `result` to `executeJob`'s outer scope and
  branching post-switch: `failed` → `markJobFailed` + `✗ Failed:`
  header + `auto-run-failed` next-actions key; `paused` →
  `markJobCompleted` + `⏸ Paused:` header + `auto-run-paused`
  next-actions key (carrying `pauseReason` into `state` so the
  `▶ Resume` button gets the right context label). Paused auto-runs
  intentionally land in `tg_jobs.status='completed'` with `result_summary`
  starting `paused:` — see "Why not add a `paused` enum value" below.

- **Redundant `markJobRunning` in `executeJob`** (related to BUG-3).
  `tryClaimJob` in `src/server.js` already sets `status='running'` and
  `started_at` when it atomically claims the job. The follow-on
  `markJobRunning(job.id)` call in `executeJob` was a no-op for the
  status field and was bumping `started_at` slightly, which threw off
  the v0.14.5 elapsed-time display in `/status`. Removed.

### Why not add a `paused` enum value on `tg_jobs.status`

Considered and deferred. A new enum would need coordinated changes in
`nextPendingJobForFreeProject`'s "running" filter, the `/status` and
`/history` displays, the `/cancel` flow, and any future `/resume`
button behaviour. The pause reason is already preserved in
`tg_jobs.result_summary` (it starts with `paused: <reason>`), so no
information is lost. Paused runs blocking the per-project FIFO picker
is also arguably correct — you don't want a second job auto-starting
on a project whose auto-run was just paused mid-phase. If that
friction ever materialises, it's a candidate for a later phase.

### Files touched

- `src/server/job-runner.js` — `notifySafe` helper; removed
  `markJobRunning`; hoisted `result`; replaced unconditional
  `markJobCompleted` with three-branch dispatch on `result?.status`.
- `src/server.js` — belt-and-braces sweep in the worker catch.
- `CHANGELOG.md`, `package.json`.

### Migrations

- None. No schema change, no config change.

### Verified

- **BUG-3 smoke** — replaced `bot_token` in `config/telegram.json` with
  a syntactically valid but invalid value, restarted, queued `/run
  <project> audit`. Console showed `[notifier] start-notify failed for
  job #N`; the audit ran to completion; `sqlite3 state/orchestrator.db
  "SELECT id, status, error_message FROM tg_jobs ORDER BY id DESC LIMIT
  3"` showed the row at `status='completed'`, never `running`. Restored
  the real token; subsequent jobs behaved normally.
- **BUG-6 paused** — with `auto_pause_after_phase_1: true` (default),
  queued `/run <fresh-project> go`. Telegram message header was
  `⏸ Paused: go <project>` (not `✓ Completed: … paused:`); inline
  keyboard had `▶ Resume` as the top button. `tg_jobs` row showed
  `status='completed'`, `result_summary` starting `paused:`.
- **BUG-6 failed** — set `overrides.budget.max_total_calls = 0` in a
  project's `project.json` (which makes `checkProjectBudget` reject
  immediately at `src/auto-runner.js:99-101`), queued `/run <project>
  go`. Header was `✗ Failed: go <project>`; `tg_jobs.status='failed'`;
  `error_message` started `paused: budget:`. Note: budget exhaustion
  surfaces as `paused` from the auto-runner — the post-switch dispatch
  treats it as paused (with `▶ Resume` available) rather than failed.
  See the "judgment call" comment trail in the Phase 2 spec; can be
  refined to map `paused + reason.startsWith('budget:')` → failed in a
  later phase if the friction is felt.
- **Belt-and-braces** — added a synthetic `throw new Error('test
  sweep')` inside `executeJob` just before the switch, queued any job.
  Worker catch logged the error; the sweep flipped
  `tg_jobs.status='running'` → `'failed'` with `error_message: 'worker
  caught uncaught: test sweep'`; the project's FIFO picker unblocked on
  the next tick. Removed the synthetic throw, restarted.


## [0.14.6] — 2026-05-24

### Fixed

- **Release zips overwrote live `config/telegram.json`** (BUG-1). Every release
  zip from v0.13.0 through v0.14.5 contained `config/telegram.json` with
  `bot_token: null`. `unzip -o` per the apply recipe silently wiped the
  operator's working token. Fixed by excluding the file from release builds;
  shipped `config/telegram.json.example` as the template, with a first-boot
  copy in `loadTelegramConfig`.
- **Release zips overwrote user project files** (BUG-2). `projects/billflow-tds/`
  contents were bundled in every zip. Moved to `examples/validators/billflow-tds/`
  so the live `projects/` tree is never touched by an apply.

### Added

- `scripts/build-release-zip.sh` — staged-directory zip builder with `.releaseignore`.
- `.releaseignore` — single source of truth for paths excluded from release zips.
- `config/telegram.json.example` — placeholder template.
- `examples/validators/billflow-tds/` — reference validators (was
  `projects/billflow-tds/validators/`). The directory ships structurally in
  this v0.14.6 zip; the actual reference content needs to be re-imported
  once from the operator's live install or a pre-v0.14.6 release branch —
  see `examples/validators/billflow-tds/PLACEHOLDER.md` for the recipe.
- `examples/README.md` — explains the reference-template convention.
- First-boot fallback in `src/server.js` `loadTelegramConfig`: copies
  `config/telegram.json.example` → `config/telegram.json` on fresh install
  with a one-line warning. Never auto-fills the bot token.

### Migrations

- None for users. Operators rebuilding release zips must use the new script.

### Verified

- `bash scripts/build-release-zip.sh 0.14.6` → `unzip -l` shows no
  `config/telegram.json` and no `projects/billflow-tds/` entries.
- First-boot copy fires on missing `config/telegram.json` (warning logged,
  file created from example, server exits 1 with the existing "No Telegram
  bot token configured" message — token NOT auto-filled).
- Apply over a populated install with a real bot token and edited
  `examples/` content leaves both byte-identical (mtime unchanged on
  `config/telegram.json`).


## [0.14.5] — 2026-05-24

### Improved — parallel-job console output is now legible

When two or more projects run in parallel on different workers, all the
deep-nested logs (model routing, claude streaming, phase progress,
validators, billing checks) now auto-prefix with `[wN project]`. No more
guessing which `Task: audit` line belongs to which project.

#### Before (v0.14.4)

```
[w1] ▶ Picking up job #6: audit billflow-tds
[w2] ▶ Picking up job #7: audit reelchain
   Task:       audit                       ← whose?
   Complexity: low
   Task:       audit                       ← whose?
   Complexity: high
   Model:      claude-opus-4-7
   Model:      claude-opus-4-7
```

The `[wN]` prefix was only on the *pickup* line. Everything after was
from deeper modules (`phase-runner.js`, `claude-runner.js`,
`auto-runner.js`, `validators.js`, `billing-guard.js`) printing with
plain `console.log()` — no awareness of which worker called them.

#### After (v0.14.5)

```
[w1] ▶ Picking up job #6: audit billflow-tds
[w2] ▶ Picking up job #7: audit reelchain
[w1 billflow-tds]   Task:       audit
[w1 billflow-tds]   Complexity: low
[w1 billflow-tds]   Model:      claude-opus-4-7
[w2 reelchain]   Task:       audit
[w2 reelchain]   Complexity: high
[w2 reelchain]   Model:      claude-opus-4-7
[w1 billflow-tds] ▶ Starting claude subprocess
[w2 reelchain] ▶ Starting claude subprocess
[w1 billflow-tds]   ... claude returned in 2.3s
[w2 reelchain]   ... claude returned in 2.4s
[w1 billflow-tds] ✓ Phase complete
[w2 reelchain] ✓ Phase complete
```

You can `grep '\[w1' logs/server.log` to see just one project's stream.

#### How it works

Used Node's built-in `AsyncLocalStorage`. Each worker calls
`workerContext.run({ workerId, project, jobId, action }, fn)` when
starting a job. `console.log/warn/error` are wrapped at startup to read
from that context and prefix accordingly. ALS preserves context across
`await` boundaries, so worker 1 yielding to worker 2 mid-job doesn't
confuse the prefixes — verified end-to-end with a 2-worker interleaving
smoke test.

Zero changes required to `phase-runner.js`, `claude-runner.js`,
`auto-runner.js`, or any of the other modules that emit logs.
The wrapper is in `src/server.js` and catches every `console.*` call
in the same process.

Logs outside any worker context — server startup, cleanup interval,
notifier callbacks, the Telegram bot dispatcher — print without prefix.
Correct, since they're not tied to a specific job.

#### Limits

- **ora spinners bypass the wrapper.** ora writes to `process.stdout`
  directly, not through `console.log`. The animated "audit done in 15m
  56s" tick at job-end therefore lacks the prefix. Not a big deal —
  the line is right after prefixed lines so context is clear, and the
  duration is also recorded in the Telegram completion notification.
  Wrapping `process.stdout.write` would also catch ora but is more
  invasive; flag if it bites.
- **Color is preserved.** `chalk`'s ANSI escapes apply to the message
  before the prefix is prepended, so colors still render in terminals
  that support them. The prefix itself is `chalk.dim()` so it's
  visually subordinate to the message.

### Also improved — `/status` shows elapsed time on running jobs

```
Currently running (2)
#12 · audit reelchain (running 3m 24s)
#13 · go billflow-tds (running 28m 11s)
```

Was just `(since 14:00:23)`. Elapsed time is more useful — you can
see at a glance which jobs are long-running vs just started, without
mentally subtracting timestamps.

### Files touched

- Modified: `src/server.js` (AsyncLocalStorage + console wrappers +
  worker context wrapping around executeJob),
  `src/server/telegram-handlers.js` (elapsed time in running list),
  `package.json`, `CHANGELOG.md`

### Migrations

- None.

### Verified

- 2-worker concurrent execution simulated end-to-end. Deep-nested
  `console.log` calls inside async functions and after await boundaries
  all received the correct prefix. Non-context logs (server startup,
  cleanup interval) printed without prefix as expected.

---

## [0.14.4] — 2026-05-24

### Added — auto-scaling worker count

The worker pool now defaults to **one worker per project**, capped at a
safety ceiling. No more guessing what number to put in config.

#### What changes

`config/defaults.json` defaults to:

```json
"job_runner": {
  "max_concurrent_projects": "auto",
  "max_workers_cap": 8
}
```

On server start:
- `"auto"` → counts projects in SQLite, spawns that many workers,
  clamped to `[1, max_workers_cap]`
- Any positive integer → uses that exact count (override)
- Anything else → falls back to auto

Server stdout now logs the decision:

```
Job processor running with 3 worker(s) [auto: 3 projects detected, capped at 8].
```

#### Why this is safe

Per-project FIFO (the picker SQL filter from v0.14.0) already enforces
"one project never uses more than one worker." So having more workers
than projects costs almost nothing — idle workers poll SQLite every
2s and sleep. No CPU spent, no memory of consequence, and crucially
**no rate-limit burn** (rate is consumed by running `claude`
subprocesses, not by workers themselves).

What this buys you: if you have 3 active projects, all 3 can have a
job running concurrently the moment you queue. Old default of 2 meant
the third project sat waiting even on a totally idle server.

What the `max_workers_cap` protects against: if you suddenly have 20
projects, you don't want to spawn 20 concurrent `claude` subprocesses
and instantly torch your Max account's 5-hour window. Default ceiling
is 8 — enough for almost any realistic project portfolio, low enough
that rate-limit can't go off a cliff.

#### `/status` now shows worker utilization

New section in `/status` output:

```
Workers
2/3 active (1 idle, auto: 3 projects, cap 8)
```

So you can see at a glance: how many workers exist, how many are
currently doing work, how many are idle ready to pick up the next
job, and whether the count came from auto-scaling or a config override.

### Files touched

- Modified: `src/server.js` (worker-count logic + listProjects import),
  `src/server/telegram-handlers.js` (Workers section in `/status`),
  `config/defaults.json` (default to auto), `package.json`, `CHANGELOG.md`

### Migrations

- None.

### Verified

- 7 decision-matrix scenarios pass: 3-project auto → 3, 1-project auto
  → 1 (minimum), 0-project auto → 1 (still 1, never 0), 15-project
  auto with cap 8 → 8 (cap respected), fixed=2 with 7 projects → 2
  (override wins), fixed=10 with 3 projects → 10, no config → auto
  default.

### How to override

If you want exactly N workers regardless of project count, set:

```json
"job_runner": { "max_concurrent_projects": 4 }
```

To restore strict v0.13 sequential:

```json
"job_runner": { "max_concurrent_projects": 1 }
```

To raise the auto ceiling (rare — only if you have 9+ projects and
genuinely want them all running simultaneously, with rate-limit
headroom to match):

```json
"job_runner": { "max_concurrent_projects": "auto", "max_workers_cap": 12 }
```

### Limits to know

- **Auto-scaling happens at server start only.** If you create a new
  project via `/new_project` while the server is running, the worker
  count doesn't increase until you restart. The new project will just
  wait its turn behind existing projects. Restart the server to scale
  up. Dynamic worker spawning at runtime is doable (~30 lines) but
  felt like overkill until you actually need it.
- **The cap is per-worker, not per-rate.** Eight idle workers spend
  no rate. Eight *running* `claude` subprocesses absolutely will, and
  `billing-guard` will start pausing them. The cap exists to prevent
  the *potential* for that, not to enforce a specific rate ceiling.
  If you find auto-scale + 8 cap routinely triggers billing pauses,
  drop the cap.

---

## [0.14.3] — 2026-05-24

### Fixed

- **"Queued" reply could say "Waiting behind itself"** when a worker
  claimed the just-enqueued job between `enqueueJob()` and the message
  format step. Prem hit this with `resume reelchain (#12) Waiting behind:
  #12 (resume, running 0s)` — the underlying behavior was correct (the
  worker did pick up #12 immediately on a free worker, as designed), but
  the bot's text reply was nonsensical.

  Root cause: `formatEnqueueReply`'s "running on this project" filter
  was `j.project === project` only. With the worker pool's ~25ms picker
  loop, a worker can claim a pending job before the message-build code
  runs, so the just-enqueued job appears in `listRunningJobs()` by the
  time we query. Fix: filter both lists by `j.id < id` (our just-
  enqueued id is by definition the highest in `tg_jobs` since the column
  is AUTOINCREMENT — anything `>= ours` is either us or doesn't exist).

  Files: `src/server/telegram-handlers.js` (formatEnqueueReply).

### Verified

- Reproduced Prem's exact scenario in simulation:
  - Pre-fix: `Waiting behind: #12 (resume, running)`
  - Post-fix: `Starts immediately on a free worker.`
- Regression check: the legitimate "waiting behind earlier same-project
  job" case still produces the correct message (`Waiting behind: #9
  (audit, running)`).

### Migrations

- None.

---

## [0.14.2] — 2026-05-24

### Improved — v0.14 worker-pool UX

Three small polish patches addressing confusing surfaces exposed by the
per-project FIFO model:

#### 1. "Queued" replies now explain *why* you're waiting

Before:
```
✓ Queued: resume reelchain (job #10)
```

After:
```
✓ Queued: resume reelchain (job #10)
Waiting behind: #9 (audit, running 1m)
Per-project FIFO: starts when prior reelchain jobs complete.
```

If nothing's blocking, it says so explicitly:
```
✓ Queued: audit reelchain (job #11)
Starts immediately on a free worker.
```

Applied to all three enqueue paths: `/queue` / `/run` text commands,
project-detail action buttons (`act:`), and the ship confirmation
callback (`confirm-yes:`).

#### 2. Project-detail buttons are state-aware

Before: every project showed all 6 action buttons (Resume, Go, Audit, Bugs,
Roadmap, Ship) regardless of whether the action made sense. Tapping
"Resume" on a fresh project with no auto-runs queued a doomed `resume`
job that would crash when its worker picked it up — Prem hit this with
reelchain.

Now `showProjectDetail` checks state and hides buttons whose action would
fail or no-op:

| Button | Shown when |
|---|---|
| ▶ Go | always |
| ⏯ Resume | a paused auto-run exists |
| 🔍 Audit | always |
| 🐞 Bugs (round N) | an in-progress bug round exists; label includes the round number |
| 🗺 Roadmap | always |
| 🚢 Ship | project has `git_branch` set and it isn't `main` |

The card also lists what's hidden in a footnote (e.g.
"_Hidden: Resume (no paused run), Bugs (no active round), Ship (no
git-managed develop branch)_") so the user sees that those actions
exist for other projects and aren't shown here for a reason.

#### 3. `/run` no longer blocks on a global "already running"

The v0.13 `handleRun` refused if ANY job was running anywhere. With
v0.14's worker pool that's wrong — cross-project concurrency is the
whole point. `/run` now simply delegates to `/queue`. The per-project
FIFO in the picker handles same-project blocking; cross-project goes
straight to a free worker.

### Files touched

- Modified: `src/server/telegram-handlers.js` (showProjectDetail
  state-aware, formatEnqueueReply helper, three callsites updated,
  handleRun simplified)
- Modified: `package.json`, `CHANGELOG.md`

### Migrations

- None.

### Verified

- formatEnqueueReply tested against 4 scenarios: empty queue (Case 1 →
  "Starts immediately"), same-project running (Case 2 → "Waiting behind
  #9 (audit, running 1m)" — Prem's exact case), cross-project running
  (Case 3 → "Starts immediately"), multi-job queue depth (Case 4 →
  "Waiting behind #12 (go, running 25m), #13 (audit, queued), #14
  (roadmap, queued)"). Output is the actual HTML the user sees.

### Known limits

- ~~**`/cancel` is not yet project-aware**~~ — fixed in v0.14.8 (BUG-5).
  Original limit text follows for context: ~~it still uses
  `getCurrentRunningJob()` (one row), so on a multi-worker setup it
  picks the most recently-started running job. If two projects are
  running simultaneously, `/cancel` may target the wrong one. Workaround
  for now: `/dequeue <job_id>` for pending jobs (always unambiguous);
  for running jobs, wait or check `/status` for the ID first. Project-
  aware `/cancel <project>` is a candidate for v0.14.3 if it bites.~~
- **`next-actions.js` suggestions** (the "What next" buttons after a
  job completes) are not yet state-filtered the same way. Those use a
  different code path; v0.14.3 candidate.

---

## [0.14.1] — 2026-05-24

### Fixed

- **`audit reelchain` (and any other job on a project created via
  `/new_project` without `--profile`) crashed with `Invalid project
  config: /profile: must be string`.** The project schema declared
  `profile` as `"type": "string"`, but `create-project.js` wrote
  `"profile": null` when no profile was passed. Two-pronged fix:
  1. `create-project.js` no longer emits null/empty optional fields.
     Generated `project.json` only contains `profile`/`tech_stack`/
     `git_branch`/`git_remote` when they have real values.
  2. `project.schema.json` accepts `["string", "null"]` for those
     fields, defense-in-depth against any other code path writing nulls.

- **Schema now documents fields the orchestrator already writes.**
  Added `guide_layout_version`, `git_branch`, `git_remote` as explicit
  properties. Expanded the `status` enum with `ready-for-qa` and
  `cancelled` — both values the orchestrator already sets in code but
  the old schema would have rejected.

### Added — documentation

`docs/NEW_FEATURES.md` extended with a "Part 2 — v0.12 through v0.14"
section covering everything shipped this session:

- Bug inbox (v0.12) — CLI, Telegram, critical-bug fast path
- Git management (v0.13) — pre-flight pull, post-success push, SHA
  capture, /sync, /ship, /git_status, /new_project, the Mac↔NAS hazard
- Per-project queues (v0.14) — picker SQL, race-condition gates,
  config knob, restore-old-behavior recipe
- Full Telegram command reference + artifact shortcut table

Doc title changed from "v0.7 through v0.11" to "v0.7 through v0.14".

### Fixing existing project files

If you have a project.json with `"profile": null` (created via
`/new_project` or `npm run new` between v0.13.3 and v0.14.0), fix in
place:

```bash
jq 'del(.profile | select(. == null))' projects/<name>/project.json \
  > projects/<name>/project.json.tmp \
  && mv projects/<name>/project.json.tmp projects/<name>/project.json
```

After v0.14.1's schema change (which accepts null), the file would
validate anyway, but the explicit-key-or-omit pattern keeps generated
files clean and matches the rest of the schema's null-aware conventions.

### Files touched

- Modified: `src/commands/create-project.js`,
  `config/schemas/project.schema.json`,
  `docs/NEW_FEATURES.md` (+~250 lines for Part 2),
  `package.json`, `CHANGELOG.md`

### Migrations

- None.

### Verified

- All four project.json shapes validate against the updated schema:
  reelchain shape (no profile, has git fields), billflow shape (with
  profile), legacy-with-null-profile (regression test), and
  `status: 'ready-for-qa'`.

---

## [0.14.0] — 2026-05-24

### Added — per-project queues with cross-project concurrency

The single-loop job processor is replaced with an N-worker pool. Each worker
independently picks jobs using a per-project-aware SQL filter, so:

- **Within a project: strict FIFO.** Two jobs on `billflow-tds` never run
  concurrently — the second waits for the first.
- **Across projects: concurrent.** While `billflow-tds go` is running 16
  fixes, `reelchain audit` can run in parallel on a different worker.
- **Bounded by `max_concurrent_projects`** in `config/defaults.json`
  (default **2**). Set to 1 to restore strict v0.13 sequential behavior.

#### How the picker works

The new SQL filter:

```sql
SELECT * FROM tg_jobs AS j
WHERE j.status = 'pending'
  AND j.project NOT IN (SELECT project FROM tg_jobs WHERE status = 'running')
  AND NOT EXISTS (
    SELECT 1 FROM tg_jobs AS earlier
    WHERE earlier.project = j.project
      AND earlier.status = 'pending' AND earlier.id < j.id
  )
ORDER BY j.id ASC LIMIT 1
```

In plain English: "give me the oldest pending job whose project isn't
already running something AND for which no older pending job exists on the
same project." That's per-project FIFO without literally maintaining
separate queues — same table, smarter SELECT.

Worker safety: an in-process mutex serializes picker calls (workers are
async coroutines in one event loop), and a new `tryClaimJob(id)` does an
atomic `UPDATE … WHERE id=? AND status='pending'` as the authoritative
gate. Race-condition window is microseconds even in adversarial scheduling.

#### Display changes

- **`/status`** now lists *all* currently-running jobs (was: one), and
  groups the pending queue by project so per-project queue depth is
  visible at a glance.
- Console output prefixes job logs with `[wN]` where N is the worker index
  (e.g. `[w1] ▶ Picking up job #42: go billflow-tds`).
- Graceful shutdown waits for every worker to finish its current job
  before exiting (was: just the single running job).

#### Config

`config/defaults.json` gains:

```json
"job_runner": {
  "max_concurrent_projects": 2
}
```

Override per host. On a low-power NAS you might want 1 (slower CPU); on your Mac
2–3 is fine. Higher values burn the Claude Max rate-limit pool faster —
you'll hit `billing-guard`'s pause earlier, so the throughput win caps
out somewhere around 2–3 in practice.

### Honest limits

- **No rate-limit win.** Two concurrent `claude` subprocesses consume the
  same shared Max account budget. Wall-clock improves for mixed workloads
  (one heavy + one light); doesn't improve for two heavy workloads —
  you'll just hit the 5-hour window's ceiling earlier and `billing-guard`
  will pause both. If you find yourself getting throttled with
  `max_concurrent_projects: 2`, drop back to 1.
- **Console interleaving.** Two workers writing to stdout simultaneously
  intermix lines. The `[wN]` prefix lets you mentally untangle them but
  it's still busier reading. Per-project log files are a future option.
- **Telegram notifications don't currently prefix project name when the
  message is generic** ("✓ Phase 3 complete"). Each `notifier.notify()`
  call already takes a `{ job }` so this is a small follow-up patch.
- **Wake lock + billing guard already designed for N callers.** Verified
  in code: wake-lock.js has reference-counted singleton ("multiple
  callers can preventSleep() concurrently"); billing-guard tracks calls
  globally regardless of which worker initiates them.

### Files touched

- Modified: `src/server.js` (worker pool replaces single loop),
  `src/server/job-queue.js` (added `nextPendingJobForFreeProject`,
  `tryClaimJob`, `listRunningJobs`),
  `src/server/telegram-handlers.js` (`/status` shows multiple running +
  per-project pending breakdown),
  `config/defaults.json` (job_runner section),
  `package.json`, `CHANGELOG.md`

### Migrations

- None. No schema change.

### Verified

- Picker SQL validated against in-memory SQLite with 5 pending jobs across
  3 projects, simulating 2 concurrent workers:
  - worker1 picks billflow#1, worker2 picks reelchain#2 (oldest of each
    different project, as designed)
  - worker3 picks imagestudio#4, correctly skipping billflow#3 and
    reelchain#5 (which are queued behind running jobs in their projects)
  - worker4 finds nothing (all 3 projects busy, as expected)
  - After completing billflow#1, picker returns billflow#3 (the queued
    one) — per-project FIFO preserved across completion

### To use

After applying the zip and restarting the server, queue any combination:

```
/run go billflow-tds
/run audit reelchain
```

You'll see both start almost immediately. The bot notifies on each
independently. `/status` shows both running + the per-project pending
queues if more are queued.

To return to v0.13 behavior (single worker):

```json
// config/defaults.json
"job_runner": { "max_concurrent_projects": 1 }
```

---

## [0.13.3] — 2026-05-24

### Added — import existing repos / create projects from Telegram

Two related capabilities, sharing one code path so they can't drift.

#### `npm run new` now handles existing repos

The `--git-remote <url>` flag is now intent-detecting instead of greenfield-only:

1. Orchestrator runs `git ls-remote --heads <url>` to probe the remote.
2. **Remote has commits** → `git clone <url>` into `projects/<name>/workspace/`,
   then run the existing migrate-git logic to create `develop` (from cloned
   HEAD if needed), push, record in SQLite.
3. **Remote is empty** → `git init` in `projects/<name>/workspace/`, initial
   commit with `.gitignore`, set remote, push to `develop` (current behavior
   from v0.13.0).
4. **Remote unreachable** (private repo without creds, network, bad URL) →
   refuses with a clear error and cleanup, so a retry doesn't trip on
   "project dir already exists".

You no longer need to `git clone` manually before `npm run migrate-git`.
That two-step flow still works for projects you've already cloned;
this is the new one-shot.

#### New Telegram command: `/new_project`

Aliases: `/newproject`, `/import`, `/addproject`.

```
/new_project reelchain https://github.com/p-j-code/reelchain.git
/new_project https://github.com/p-j-code/reelchain.git     ← name inferred from URL
```

Runs inline (no job queue — most clones are sub-30s). Reports mode
(cloned vs greenfield), file count, branch, remote, and what to do
next (`/git_status`, `/pin`).

#### Shared `createProject()` function

New module `src/commands/create-project.js` is the single source of
truth for project creation. Both CLI and Telegram paths call it.
Exports also include `inferNameFromGitUrl()` and `looksLikeGitUrl()`
helpers for input validation.

#### What's preserved on the host

If you re-run `/new_project` with an existing name, it refuses (both
project dir and SQLite row). If clone fails partway, the half-created
project dir is cleaned up so a retry is safe.

### Files touched

- New:      `src/commands/create-project.js`
- Modified: `src/lib/git.js` (added `remoteHasRefs`, `cloneRepo`),
            `src/orchestrator.js` (`new` command uses createProject),
            `src/server.js` (handleNewProject import + registration),
            `src/server/telegram-handlers.js` (handleNewProject appended),
            `package.json`, `CHANGELOG.md`

### Migrations

- None.

### Verified

- `remoteHasRefs` on a populated bare repo → `{ok:true, hasRefs:true}`
- `remoteHasRefs` on an empty bare repo → `{ok:true, hasRefs:false}`
- `remoteHasRefs` on a bogus URL → `{ok:false, error: ...}`
- `cloneRepo` clones a populated bare into a target dir, lands on the
  remote's default branch, files present.

### Limits to know

- **Authentication**: Private repos require credentials on the host
  (SSH key, or `git credential.helper` configured). Orchestrator can't
  prompt mid-clone. If clone fails with `Authentication failed` or
  `Permission denied`, set up credentials and re-run. Use SSH URL form
  (`git@github.com:user/repo.git`) if you have a key.
- **Timeout**: Clone has a 5-minute timeout. Very large repos on slow
  networks may need to be cloned manually first, then `npm run migrate-git`.
- **Telegram inline execution**: clones run in-process — large/slow
  clones may approach Telegram's implicit response window. If you ever
  hit this, the orchestrator still completes the work; the bot just may
  not reply with the success message until much later. Check
  `/git_status <name>` to verify.
- **Brief is still a separate step**: `/new_project` creates the project
  but doesn't write `.guide/brief.md`. Drop a brief later when you want
  to plan phases. You can use the project for `/preview`, `/file`,
  `/git_status` immediately without one.
- **Tech stack / profile aren't yet exposed in `/new_project`**.
  Telegram args are positional `<name> <url>`. If you need them, use the
  CLI: `npm run new -- <name> --git-remote <url> --tech "..." --profile <p>`.

---

## [0.13.2] — 2026-05-24

### Fixed

- **`npm run promote -- <project> --from-audit` failed with "No 'Promote
  to bugs-round-N' section found" when Opus code-formatted the round name
  in the section heading** — e.g., ` ## Promote to \`bugs-round-7\` `.
  The extractor's regex (`audit-promote.js:14`) expected literal
  `Promote\s+to\s+bugs` and didn't tolerate backticks, asterisks, or
  underscores around the identifier. Loosened the regex to accept any
  combination of `` ` ``, `*`, `_` around both `Promote` and the round
  identifier, on both sides. Also expanded the round number from a
  single optional digit to one-or-more digits so multi-digit rounds
  (e.g., `bugs-round-12`) match.

### Files touched

- Modified: `src/lib/audit-promote.js` (regex only), `package.json`,
  `CHANGELOG.md`

### Migrations

- None.

### Verified

- 11 regex test cases (8 should-match decoration variants + 3 negative
  controls): all pass.
- The case Prem hit on 2026-05-24 (`## Promote to \`bugs-round-7\``)
  now matches.

### If you don't want to apply v0.13.2 just yet

Existing audits with decorated headings can be unblocked with sed in
place:

```bash
sed -i.bak -E 's/^(#{2,}\s+Promote\s+to\s+)\`?(bugs[-_ ]round[-_ ]?[0-9N]+)\`?/\1\2/' \
  projects/<name>/.guide/audits/<audit-file>.md
npm run promote -- <name> --from-audit
```

---

## [0.13.1] — 2026-05-24

### Fixed

- **`/preview` crashed the bot with 400 "message is too long" on audits
  containing large code-fenced sections** (`preview-handlers.js:355`,
  inside `splitForTelegram`). Two bugs in one:

  1. The splitter had a `!inCodeBlock` guard that refused to break inside
     ` ``` ` fences. Intended to keep markdown valid across messages, but
     Telegram `<pre>` is opaque (treats fences as plain text), so the
     guard was both unnecessary AND unsafe — a code block longer than
     `maxChars` would never get split, producing one oversize chunk and
     a 400 from `sendMessage`. Guard removed. Splitter now always breaks
     on the closest line boundary that fits.

  2. HTML escaping (`<` → `&lt;`, `&` → `&amp;`, `>` → `&gt;`) inflates
     length by up to 3 chars per occurrence. The prior `TELEGRAM_MAX_CHARS`
     of 3800 left only 296 chars of headroom over Telegram's 4096 limit,
     which content with many angle brackets would blow through. Lowered
     to 3200 (≈900 chars headroom).

  3. Single lines longer than `maxChars` (minified JSON, long URLs, base64
     blobs) couldn't be line-split. Added a hard char-split fallback as
     last-resort safety.

- **Defensive try/catch around each chunk send in `handlePreview`.**
  If Telegram still returns 400 (future template changes, unusual content),
  the handler now bisects the offending chunk and retries; on any other
  error, it surfaces a path-only fallback ("Read directly: `.guide/...`")
  instead of crashing the whole reply. The bot stays online.

### Files touched

- Modified: `src/server/preview-handlers.js` (splitter + defensive send),
  `package.json` (version), `CHANGELOG.md`

### Migrations

- None.

### Verified

- Reproduced the original crash with synthetic content (200-line fenced
  block, 17KB total). Pre-fix: 1 chunk of 7000+ chars → 400. Post-fix:
  6 chunks, max 3192 chars unescaped / 3414 chars escaped, all under 4096.
- Pathological 6000-char single line correctly splits into 2 chunks via
  the hard char-split fallback.

### Don't forget

- This is a complete drop-in zip — applying it gets you everything in
  v0.13.0 (git management: pull-before-dispatch, push-after-success,
  `/ship`, `/sync`, `/git_status`, `migrate-git`) plus this preview fix.
  You don't need to apply v0.13.0 separately.

---

## [0.13.0] — 2026-05-24

### Added — git management

The orchestrator now actively manages git for each project: it captures
commit SHAs, pushes after every successful phase/fix, gates dispatch on a
clean git state, and provides a `/ship` command for promoting develop → main.

**Why:** prior to v0.13, the orchestrator only told the dev agent to commit;
pushing was either improvised by the agent or done manually. Running the
orchestrator on a NAS while pulling changes on a Mac required guaranteed
pushes — that's now built in.

#### Per-project git config

Two new columns on `projects` (idempotent ALTER, safe on existing DBs):
- `git_branch` — the branch the agent works on (default `develop`). Pre-flight
  refuses to dispatch dev if workspace isn't on this branch.
- `git_remote` — origin URL, for visibility (the actual push uses the
  workspace's git remote, not this string).

When `git_branch` is NULL (legacy projects pre-migrate), the orchestrator
preserves old behavior: no pre-flight, no push, no SHA capture. Run
`npm run migrate-git -- --project <name>` to opt in.

#### Phase/fix lifecycle

**Before** every successful dev invocation, the orchestrator now:
1. Verifies workspace is a git repo, has origin, is on `git_branch`
2. Runs `git fetch origin <branch>`
3. Decides based on ahead/behind state:
   - `noop` → proceed
   - `behind` only → `git pull --ff-only` then proceed (this is the "Mac pushed → NAS pulls before running" case)
   - `ahead` only → proceed (next push will publish local commits)
   - `diverged` (both ahead and behind) → **halt** with a clear reconciliation recipe. Never auto-rebases or auto-merges.
   - fetch / pull-failed → halt with the underlying git error

**After** every successful dev invocation, the orchestrator now:
1. Captures HEAD SHA via `git rev-parse HEAD`
2. Stores it in `phases.commit_sha` (unblocking `retry-phase`, which was
   broken because no SHA was ever recorded)
3. Runs `git push --set-upstream origin <branch>` with no force
4. On push failure: logs a yellow warning, does NOT fail the phase, includes
   the failure in `runDev`'s return as `git_result.error`

#### New commands

- **`npm run migrate-git -- --project <name>`** — brings an existing project
  under management. Verifies repo + remote, creates `develop` from current
  HEAD if missing, pushes it, records the branch/remote, appends standard
  `.gitignore` entries. Idempotent. Flags: `--branch <name>` (default
  `develop`), `--remote <url>` (set origin if missing), `--init` (run
  `git init` for never-initialized workspaces).

- **`npm run ship -- <project> [--tag vX.Y.Z]`** — fast-forward main to
  develop, push, optionally tag. Refuses if:
  - workspace dirty
  - develop is ahead of origin/develop (push first)
  - main has diverged from develop (no FF possible)
  - already in sync (no-op, exits 0)
  Returns to develop after success.

- **`npm run git-status -- <project>`** — branch, remote, working-tree
  cleanliness, ahead/behind vs origin, ship-lag (develop ahead of main).
  Same output structure used by the Telegram handler.

- **`npm run sync -- <project>`** — manual fetch + fast-forward of the
  configured branch. Same logic the pre-flight runs, but invokable on
  demand for "I just pushed from Mac, freshen NAS." Halts on divergence
  with the same reconciliation recipe.

- **Telegram: `/ship <project> [--tag vX.Y.Z]`** — aliases `/shipproject`.
- **Telegram: `/git_status <project>`** — aliases `/gitstatus`, `/git`.
- **Telegram: `/sync <project>`** — aliases `/pull`, `/gitpull`.

#### `/ship` syncs develop with origin first

The ship command runs the same sync logic against `develop` before
fast-forwarding `main`. This catches the case where someone pushed to
origin/develop from a host other than the one running `/ship`, ensuring
the FF to main includes those commits. If local develop has unpushed
commits, ship halts and asks you to push first (so origin develop
matches local develop before main is updated).

#### Project creation (`npm run new`)

Now defaults to git-managed. Flags:
- `--git-remote <url>` — **required** unless `--no-git`
- `--git-branch <branch>` — default `develop`
- `--no-git` — explicit opt-out (warns)

`npm run new` invokes `migrate-git` internally to init, set remote, push.

#### Dev system prompt

`prompts/dev-system.md` step 5 now explicitly says: **commit only, do not
push, do not switch branches**. The orchestrator handles those. This stops
the dev agent from racing the orchestrator's push.

#### Files touched

- New: `src/lib/git.js`, `src/commands/migrate-git.js`, `src/commands/ship.js`,
  `src/commands/git-status.js`
- Modified: `src/lib/phase-runner.js` (pre-flight + post-success push),
  `src/state.js` (schema ALTERs + `setProjectGitConfig`),
  `src/orchestrator.js` (new + migrate-git/ship/git-status CLI commands),
  `src/server.js` (handler imports + command registration),
  `src/server/telegram-handlers.js` (handleShip + handleGitStatus appended),
  `prompts/dev-system.md` (commit-only clarification),
  `package.json` (version + scripts)

#### Migrations

- Schema additions to `projects` are applied automatically on first DB open
  via the existing `migrate()` flow — no separate `npm run migrate-*`
  command needed.
- Existing projects (e.g. billflow-tds) won't change behavior until you run
  `npm run migrate-git -- --project <name>` for each one.

#### Limits to know

- **Push failure surfaces only in stdout/journalctl**, not in real-time
  Telegram notifications. If you're running under systemd, `journalctl -u
  ashmero-orchestrator | grep "Push failed"` catches them. Adding live
  Telegram notification for push failures is a v0.13.1 candidate.
- **Per-fix SHAs are not stored** — only per-phase. There's no `fixes`
  table to hold them. Fixes still get committed + pushed; the SHA just
  doesn't persist beyond the orchestrator's logs. If you need it, it's in
  `git log` on the workspace.
- **Concurrent push from two hosts will fail the second push** (by design
  — no force). If you push from Mac while orchestrator runs on NAS,
  orchestrator's push fails with "non-fast-forward". Practical rule: NAS
  pushes, Mac pulls.
- **No support for non-`origin` remotes** — the implementation assumes
  origin. Multi-remote workflows aren't supported.

---

## [0.12.4] — 2026-05-24

### Fixed
- **`/bug_promote` and critical-bug "🚨 Run now" button now actually run** — previously they replied with a CLI command for the user to copy and paste. The reasoning ("bot can't spawn claude subprocesses") was wrong: `/run go` already does exactly that via the existing job queue + job-runner. Now `/bug_promote`, the critical-bug fast-path button, "Promote all" button, and "Promote critical" button all:
  1. Perform the promote inline (SQL + bugs.md write — milliseconds, no LLM call)
  2. Enqueue a `go` job
  3. Reply with the job ID and "progress notifications incoming"

  The full bug-capture → triage → promote → fix → notification cycle is now possible entirely from Telegram without ever touching the Mac terminal.

### Refactored
- Extracted `performBugPromote()` as a pure function in `src/commands/bugs-inbox.js` — used by both the CLI `npm run bug -- promote` and the Telegram handlers. Eliminates drift between the two surfaces.

### Files touched
- Modified: `src/commands/bugs-inbox.js` (extract pure function, CLI uses it), `src/server/telegram-handlers.js` (4 promote-related callsites now do work instead of suggesting CLI commands; added `path` + `REPO_ROOT` imports)

### Migrations
- None.

### Don't forget
- v0.12.3 already required the BotFather command list to use underscores (`bug_promote` etc). If you haven't updated that yet, do so now — see message body for the list.

---


## [0.12.3] — 2026-05-24

### Fixed (significant — affects all bug-* Telegram commands)
- **Telegram bot commands can't contain hyphens.** Per the Telegram Bot API, command names are restricted to `[a-zA-Z0-9_]`. The v0.12.0 `bug-capture`, `bug-done`, `bugs-inbox`, `bug-promote` commands were silently parsed as `/bug` + text body, so `/bug-promote` would create a bug with text "-promote". Renamed all to underscored versions: **`/bug_capture`, `/bug_done`, `/bugs_inbox`, `/bug_promote`**. Compact aliases also registered: `/bugcapture`, `/bugdone`, `/bugsinbox`, `/buginbox`, `/bugpromote`.

### Files touched
- Modified: `src/server.js` (command registration with aliases), `src/server/telegram-handlers.js` (all user-facing text + regex strip patterns), `src/lib/next-actions.js` (suggestion labels)

### Migrations
- None — code-only.

### Don't forget
- **Re-run BotFather `/setcommands`** with the renamed commands (see message body).
- Any bugs captured with text like `-promote` or `-capture` (from the original broken syntax) are garbage — drop them with `npm run bug -- <project> drop <id>`.

---


## [0.12.2] — 2026-05-24

### Fixed
- **Auto-runner ignored bug rounds whose `bugs.md` + `plan.json` existed on disk but had no in-progress SQL row** — predict would correctly identify "bug round N pending" but `npm run go` would pause with "all phases done, ready for QA." The dispatch table now handles all four states:

  | bugs.md | plan.json | SQL row | New behavior |
  |---|---|---|---|
  | ✗ | — | — | continue to phases |
  | ✓ | ✗ | — | generate fix plan |
  | ✓ | ✓ | in-progress | execute fixes (unchanged) |
  | ✓ | ✓ | **missing or completed** | **bridge into SQL with status='in-progress', then execute** |

  This bridges manual or `bug-promote`-created rounds into the auto-runner without needing `npm run bugs` re-planning.

### Files touched
- Modified: `src/auto-runner.js` — `detectNewBugRound` now signals `{needsPlan, autoStart}`; `pickNextAction` inserts SQL row from existing plan when `autoStart=true`. New imports: `getBugRound`, `startBugRound`, `bugsFilePath`.

### Migrations
- None.

---


All notable changes to the Ashmero Orchestrator. Each version shipped as a complete drop-in zip.

## [0.12.1] — 2026-05-24

### Fixed
- **Crash on `/run go` for projects with all phases completed** — `pickNextAction` referenced the local variable `ar` (alias for `cfg.auto_run`) that was declared inside `autoRun`, not `pickNextAction`. The bug only fires when `completedPhase >= totalPhases` (i.e., all phases done) at line 173. Affected any project past final phase. Now `ar` is declared locally inside `pickNextAction` to mirror `autoRun`'s pattern. This bug predates v0.12 — long-standing latent issue.

### Files touched
- Modified: `src/auto-runner.js` (one-line scope fix)

### Migrations
- None.

### How to verify the fix
```bash
npm run go -- billflow-tds
```
For billflow-tds specifically (8/8 phases done, bug round 4 in-progress), the auto-runner should now pick up round 4's remaining fixes. If it instead goes to the "all phases done, ready for QA" branch, the bug-round state in SQLite needs inspection — see the message body.

---


All notable changes to the Ashmero Orchestrator. Each version shipped as a complete drop-in zip.

## [0.12.0] — 2026-05-24

### Added — Bug Inbox (parallel to Requirements Inbox)

A new lightweight capture path for bugs. As you find them in the wild — testing, code review, audit — drop them into a project's bug inbox, refine + triage when convenient, then promote into a bug round when you're ready to fix.

- **`/bug <project> <text>`** — capture bug from Telegram; respects pinned project
- **`/bug <project> critical: <text>`** — inline severity tag; critical triggers a fast-path prompt with [🚨 Run now / 📋 Queue / Just save] buttons
- **`/bug-capture <project>` / `/bug-done`** — multi-message capture mode (mirror of `/capture`)
- **`/bugs-inbox [<project>]`** — review pending bugs grouped by severity, with promote buttons
- **`/bug-promote <project>`** — generate `bugs.md` for next round from all pending; `--critical` for just criticals
- **CLI**: `npm run bug -- <project> {add|list|show|set|drop|refine|promote|stats}`
  - `refine` runs an AI pass to structure raw texts into title / repro / expected / actual / likely files
  - `promote --ids 3,5,8 --run` creates round-N+1 with selected bugs and auto-starts the fix cycle

### Schema
- New table: `bug_inbox` (id, project, raw_text, refined_text, severity, status, source, reported_by, tags, promoted_to_round, notes, created_at, updated_at)
- Extended `tg_capture_modes` with `kind` column ('req' | 'bug') so message router knows which inbox to capture into

### Severity model
Four levels: `critical | major | minor | unassigned`. The `bug_inbox` view in `/bugs-inbox` is sorted critical-first. Promotion groups bugs by severity in the generated `bugs.md` so the dev agent gets them in the right order.

### Integration with existing features
- `audit` next-actions now include "📥 Save findings to bug inbox" as the second option
- `bug-promoted` is a new next-actions case suggesting `/run <project> bugs` afterward
- The bug-promote command writes to the canonical `.guide/bug-rounds/round-N/bugs.md` path; rounds are created with `mkdir -p` so the structure is consistent with auto-runner expectations

### Files touched
- New: `src/migrate-bug-inbox.js`, `src/commands/bugs-inbox.js`
- Modified: `src/state.js` (CRUD helpers + extended capture-mode helpers), `src/orchestrator.js` (CLI registration), `src/server.js` (bot command wiring), `src/server/telegram-handlers.js` (5 handlers + callback dispatcher + help topic), `src/lib/next-actions.js` (audit + bug-added + bug-promoted cases), `package.json` (scripts)

### Migrations
- **`npm run migrate-bug-inbox`** — creates the `bug_inbox` table and adds the `kind` column to `tg_capture_modes`. Idempotent.

### Don't forget
- Re-run BotFather `/setcommands` to add `bug`, `bug-capture`, `bug-done`, `bugs-inbox`, `bug-promote` to the autocomplete dropdown (see message body).

---

## [0.11.7] — 2026-05-24

### Fixed (significant)
- **Phase/fix reports were going to flat paths** — `prompts/dev-system.md` and `prompts/review-template.md` told the dev/review agents to write reports to `.guide/phase-{N}-report.md` and `.guide/fix-round-{R}-fix-{N}-report.md` (legacy v1 flat paths), while every code path that reads reports (`phaseReportPath`, auto-runner's prev-report context-load, `/preview`, QA handoff generator, validators) looks in `.guide/phases/NN-<slug>/report.md` and `.guide/bug-rounds/round-R/fixes/NN-<slug>/report.md` (canonical v2 nested paths). Result: reports were being written but never read for context. Auto-runner silently lost cross-phase memory; `/preview phase:N` and QA handoffs missed fix reports.
- **Three-pronged fix:**
  1. `prompts/dev-system.md` updated to nested paths
  2. `prompts/review-template.md` updated to nested paths
  3. `src/lib/phase-runner.js` now injects the EXACT report path into the dev prompt as a header (`**Report path:** \`<path>\``) so the LLM cannot construct a wrong path even if it forgot its system-prompt instructions
- **`migrate-layout --force` / `--repair`** — bypasses the "already v2, skipping" check so projects on v2 can consolidate any stray flat report files written by older orchestrator versions.

### Files touched
- Modified: `prompts/dev-system.md`, `prompts/review-template.md`, `src/lib/phase-runner.js`, `src/orchestrator.js`, `src/migrate-guide-layout.js`

### Migrations
- None new — but you should run **`npm run migrate-layout -- --force --project <name>`** on existing projects to relocate any stray flat report files into the correct nested folders.

---


All notable changes to the Ashmero Orchestrator. Each version shipped as a complete drop-in zip.

## [0.11.6] — 2026-05-24

### Added
- **Multi-item `roadmap-accept`** — accept multiple roadmap items at once via `--items 1,3,5` or `--items 1-5` (ranges), or `--all`.
- **`--to-inbox <target>` mode** — drop each selected roadmap item as a triagable requirement into any project's inbox. The whole orchestrator chain composes: roadmap → inbox → triage → promote → brief → plan → go.
- **Smart roadmap parsing** — `roadmap-accept` parses the roadmap into discrete items by detecting `## N. Title`, `## Item N: Title`, `### N. Title`, or `## Suggestion N` headings. Items are listed in raw-thoughts.md cleanly when spinning off a new project.
- **Updated next-actions for roadmap** — now suggests three accept paths (single item, multi-item, dump-to-inbox) with descriptions.

### Files touched
- Modified: `src/orchestrator.js` (roadmap-accept command rewrite + helpers), `src/lib/next-actions.js`

### Migrations
- None.

### Backward compatibility
- The original `--item <n> --new-project <name>` syntax still works exactly as before.

---

## [0.11.5] — 2026-05-24

### Fixed
- **Roadmap next-actions were misleading** — the "▶ Execute roadmap" button mapped to `/run go`, but `/run go` executes the existing plan; a roadmap is forward-looking advice, not a phase list. Replaced with three accurate dev paths:
  - 🚀 Spin off item as new project (the real dev path — `npm run roadmap-accept`)
  - 📝 Extend current project (merge insights into raw-thoughts → re-brief → re-plan)
  - 🐛 Treat as deferred fixes (`guide --task bug-plan`)
  - ▶ Continue existing plan (kept but with a note clarifying it runs the existing plan, not the roadmap)

### Added
- **`roadmap-accepted` next-actions** — after `npm run roadmap-accept`, the CLI now shows next-steps (draft brief, generate plan, auto-run when planned, predict cost) using the next-actions engine instead of hardcoded text.

### Files touched
- Modified: `src/lib/next-actions.js`, `src/orchestrator.js`

### Migrations
- None.

---

## [0.11.4] — 2026-05-24

### Added
- **Pinned project in Telegram** — run any project-taking command without the project argument and get a tappable picker. Tap a project → it's pinned. All subsequent commands use that project automatically until you `/unpin` or pick another.
- **New commands:** `/pin [project]`, `/unpin`, `/pinned`
- **`/status` shows the pinned project** at the top when one is set
- **`/req` honors the pin** for "no project" captures (was always `_inbox` before)

### Affected commands (all use pinned project as fallback)
- `/project`, `/run`, `/queue`, `/download`
- `/capture`, `/triage`, `/inbox`
- `/req <text>` (when no project specified)
- `/preview`, `/files`, `/file` — also supports `/preview roadmap` (artifact only) when pinned

### Files touched
- Modified: `src/migrate-bot.js`, `src/server/job-queue.js`, `src/server/telegram-handlers.js`, `src/server/preview-handlers.js`, `src/server.js`

### Migrations
- Re-run `npm run migrate-bot` to add the `tg_pinned_projects` table (idempotent — existing data untouched).

### Don't forget
- Re-run BotFather `/setcommands` (or `/mybots → Edit Bot → Edit Commands`) to add `pin`, `unpin`, `pinned` to the `/` autocomplete dropdown.

---

## [0.11.3] — 2026-05-24

### Added
- **`/preview`, `/files`, `/file` Telegram commands** — read project artifacts inline or as `.md` downloads, away from the Mac. Shortcuts: `roadmap`, `audit`, `plan`, `brief`, `phase:5`, `bugs:4`, `fix:4:13`, `review:6`, `qa:4`, etc.
- **Next-actions engine** — contextual "what next" suggestions appear after every major operation completes:
  - CLI: printed as a "▸ What next:" block with copy-pastable commands
  - Telegram: inline-keyboard buttons (top 4 visible, "📚 More options" expands to all)
- **Integrated next-actions into:**
  - Auto-runner finalize (completed / paused / cancelled / failed)
  - Telegram job-completion notifications
  - CLI: `audit`, `qa-handoff`, `triage`, `predict`
  - `/preview` shown (suggests project status, more files)

### Files touched
- New: `src/lib/next-actions.js`, `src/server/preview-handlers.js`
- Modified: `src/server.js`, `src/server/telegram-handlers.js`, `src/server/notifier.js`, `src/server/job-runner.js`, `src/auto-runner.js`, `src/orchestrator.js`, `src/commands/triage.js`

### Migrations
- None.

### Don't forget
- Re-run BotFather `/setcommands` (or `/mybots → Edit Bot → Edit Commands`) to add `preview`, `files`, `file` to the `/` autocomplete dropdown.

---

## [0.11.2] — 2026-05-24

### Added
- **`/help` Telegram command** — categorized command overview at `/help`; topic deep-dives via `/help req`, `/help triage`, `/help validators`, `/help predict`, `/help qa`, etc. Self-documenting bot.
- **`/docs` Telegram command** — DMs you a zip of the full `docs/` folder + CHANGELOG.md + README.md for offline reading away from the Mac.

### Changed
- `/start` for authorized users now shows a categorized command quick-reference and points to `/help` for details.

### Files touched
- Modified: `src/server/telegram-handlers.js`, `src/server.js`

### Migrations
- None.

### Don't forget
- Re-run BotFather `/setcommands` (or `/mybots → Edit Bot → Edit Commands`) to add `help` and `docs` to Telegram's `/` autocomplete dropdown.

---

## [0.11.1] — 2026-05-24

### Fixed
- **Telegram auth-code flow** — auth codes now persist in SQLite (`tg_auth_codes` table) so the issuer (`npm run bot-auth-code`) and consumer (the server's `/auth` handler) see the same data across processes. Previously codes lived in a per-process in-memory Map, so they silently never reached the server. `bot-auth-code` no longer hangs for 15 minutes; it exits immediately after printing the code.

### Files touched
- Modified: `src/migrate-bot.js`, `src/server/job-queue.js`, `src/orchestrator.js`

### Migrations
- Re-run `npm run migrate-bot` to add the `tg_auth_codes` table (idempotent — existing data untouched).

---

## [0.11.0] — 2026-05-24

### Added
- **QA handoff generator** (`npm run qa-handoff -- <project>`) — produces a tester-friendly markdown checklist from `bugs.md`, fix reports, validator runs, and git history. Two modes: extractive (free, instant) and `--with-steps` (one Opus call, ~$1-2, generates plain-English manual test procedures). Output to `.guide/qa-handoffs/`.
- `--round <n>` / `--phases <a>:<b>` scope selection; defaults to most recent bug round.

### Changed
- `src/lib/guide-paths.js` adds `qaHandoffsDir`, `qaHandoffPath` helpers.

### Files touched
- New: `src/commands/qa-handoff.js`
- Modified: `src/orchestrator.js`, `src/lib/guide-paths.js`, `package.json`

### Migrations
- None.

---

## [0.10.0] — 2026-05-23

### Added
- **Fast triage TUI** (`npm run triage -- <project>`) — raw-keypress single-action interface for the requirements inbox. `0/1/2/3` set priority, `n/x/l` set scope and auto-advance, `a` triggers Opus suggestion, `s/d/q` for skip/drop/quit. Cleared-screen rendering, session summary on exit.
- **Telegram fast triage** (`/triage <project>`) — inline-keyboard message per item, scope tap auto-advances. 1-2 taps per item vs 5 with the old `/inbox` flow.
- **Auto-run summary block** — on completion, cancel (Ctrl-C), pause, or failure: start time, end time, wall time, call breakdown by task, cost, tokens.
- **Cumulative run time** in every action header (`▶ Execute fix: ...   [run: 12m 34s]`).
- **Graceful SIGINT** — Ctrl-C during a run marks it `cancelled`, prints the summary, exits. Second Ctrl-C force-quits.

### Fixed
- **Null bytes in spawn args** — LLM outputs occasionally contain raw `\0` bytes that propagate into prompt files. Node's `spawn()` rejects strings with null bytes. v0.10 sanitizes all args before spawn and emits a one-line warning when stripping occurs.

### Files touched
- New: `src/commands/triage.js`
- Modified: `src/orchestrator.js`, `src/server.js`, `src/server/telegram-handlers.js`, `src/auto-runner.js`, `src/claude-runner.js`, `package.json`

### Migrations
- None.

---

## [0.9.0] — 2026-05-23

### Added
- **Cost prediction** (`npm run predict -- <project>`) — predicts upcoming phase/fix costs from historical averages in the `calls` table. Integrated into `npm run go` and `npm run resume` as a pre-flight check with y/N confirmation when predicted cost ≥ $1 or budget would be exceeded. Bypass with `--yes` or `--no-predict`.
- **External validators** — new `validators/` folder per project + `validators.json` config with rules. Auto-run after every dev/fix execution. Failures pause the auto-runner. Use `npm run validate -- <project>` for ad-hoc runs and `npm run validators -- <project>` for history.
- BillFlow ships with 4 example validators: `smoke.sh`, `tests.sh`, `nsdl-fvu.sh`, `gstr-1-schema.js`.

### Files touched
- New: `src/commands/predict.js`, `src/lib/validators.js`, `src/migrate-validators.js`
- New: `projects/billflow-tds/validators/{smoke.sh, tests.sh, nsdl-fvu.sh, gstr-1-schema.js, README.md}`, `projects/billflow-tds/validators.json`
- Modified: `src/orchestrator.js`, `src/auto-runner.js`, `src/state.js`, `config/defaults.json`, `package.json`

### Migrations
- `npm run migrate-validators` — adds `validator_runs` table.

---

## [0.8.0] — 2026-05-23

### Added
- **Live spinner with elapsed time** for every claude subprocess call (`ora` library). Replaces noisy `[runner] ...` log lines. Non-TTY environments degrade to plain text.
- **Mac wake lock** (`caffeinate -i -s`) — refcounted singleton, no-op on Linux/NAS. Active during any in-flight claude call AND for the full span of `npm run go`/`npm run server`. Released on SIGINT and process exit.

### Files touched
- New: `src/lib/wake-lock.js`
- Modified: `src/claude-runner.js`, `src/auto-runner.js`, `src/server.js`, `config/defaults.json`

### Migrations
- None.

---

## [0.7.0] — 2026-05-23

### Added
- **Cleanup** (`npm run cleanup`) — prunes old `logs/*.log`, dashboard files in `outputs/`, and stale rows in the `calls` table. Auto-runs at server boot and every 6 hours. Configurable retention in `config/defaults.json`.
- **Project context** (`npm run context -- <project>`) — generates `.guide/project-context.md` with domain, audience, regulatory regime, UX conventions, and project-specific prompting rules. Injected as system-prompt prefix on every guide/dev call.
- **Project-specific routing extension** — `projects/<name>/routing-extension.json` merged into global keyword rules. BillFlow ships with tax/multitenancy/payments rules.
- **Requirements inbox** (`npm run req -- <project> ...`) — capture/list/triage/refine/promote raw thoughts as structured requirements. CLI subcommands: `add`, `list`, `show`, `triage`, `set`, `drop`, `refine`, `promote`, `stats`, `projects`. Telegram: `/req`, `/capture`, `/done`, `/inbox`. Refine batches all inbox items through Sonnet to produce structured title/what/why/touches/open-questions per item.
- BillFlow's `project-context.md` pre-populated with Indian SME / GST / TDS / multitenancy rules.

### Files touched
- New: `src/lib/log-cleanup.js`, `src/migrate-requirements.js`, `src/commands/requirements.js`
- New: `prompts/templates/project-context-template.md`
- New: `projects/billflow-tds/.guide/project-context.md`, `projects/billflow-tds/routing-extension.json`
- Modified: `src/orchestrator.js`, `src/server.js`, `src/server/telegram-handlers.js`, `src/state.js`, `src/claude-runner.js`, `src/lib/phase-runner.js`, `src/lib/guide-paths.js`, `src/model-router.js`, `config/defaults.json`, `package.json`

### Migrations
- `npm run migrate-requirements` — adds `requirements` and `tg_capture_modes` tables.

---

## [0.6.0] — 2026-05 (baseline)

See `HANDOFF.md` for full pre-v0.7 history. Major capabilities:
- 4-layer config cascade, SQLite state, billing guard, system prompts, profiles, schemas
- Auto-runner with layered checkpoints, bug-fix cycle
- Model router with complexity scoring
- Brief / audit / roadmap modes
- `package`, `upgrade-project`, `retry-phase`, `inspect`, `dashboard`, `budget` commands
- Telegram bot (grammy), long-running server, FIFO job queue, allowlist
- Mid-phase hard cancellation, per-project budget cap
