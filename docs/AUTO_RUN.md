# Auto-Run Workflow

The end-to-end automated path: drop a brief, run one command, walk away.

## The full lifecycle

```
You drop brief.md
        ↓
npm run go ── orchestrator generates plan
        ↓
        ↓ ── auto-pauses after phase 1 (foundation check)
        ↓
npm run resume
        ↓
        ↓ ── runs phases 2, 3 + review after 2
        ↓ ── auto-pauses after review (you read it)
        ↓
npm run resume
        ↓
        ↓ ── runs phases 4, 5 (with Opus for risky ones) + review after 4
        ↓ ── auto-pauses after review
        ↓
... repeat until final phase ...
        ↓
        ↓ ── auto-pauses after final phase
        ↓
You do manual QA on workspace/
        ↓
   ┌────┴────┐
  no bugs   bugs found
   │             │
   ↓             ↓
npm run qa    Write .guide/bugs-round-1.md
  --shipped       ↓
   │           npm run go (auto-detects bugs file)
   │              ↓
   │              ↓ ── guide produces fix-plan-round-1.json
   │              ↓ ── runs fix 1, 2, 3, ... auto-pauses between
   │              ↓
   │           Re-test workspace/
   │              ↓
   │           Either: bugs-round-2.md (loop) OR npm run qa --shipped
   ↓
project.status = completed
```

## Commands

### Starting a new project end-to-end

```bash
# 1. Create project
npm run new -- mymodule --profile nextjs-saas --tech "React + Node + MongoDB"

# 2. (For existing codebase) extract into workspace/
cd projects/mymodule/workspace && unzip ../inputs/existing.zip && cd ../../..

# 3. Drop the brief
code projects/mymodule/.guide/brief.md
# (write or paste the brief, save)

# 4. Go
npm run go -- mymodule
```

The orchestrator will:
- Generate `plan.json` and `plan.md`
- Generate `phase-1-prompt.md`
- Run phase 1 dev
- Pause for you to inspect (after phase 1)

### Resuming after a checkpoint

```bash
# Read the pause reason
npm run status -- mymodule

# Review .guide/plan.md or .guide/review-after-N.md or the last phase report
# When satisfied:
npm run resume -- mymodule
```

### Unattended mode (use carefully)

```bash
npm run go -- mymodule --unattended
```

Skips all checkpoints EXCEPT errors and budget. Use when:
- You trust the plan completely
- You're running overnight
- The module is small and low-risk

Even unattended, it pauses on:
- Phase errors (`is_error: true` in dev report)
- Budget pause threshold (default 80 calls in 5h)
- Final phase (to give you a chance to QA)

### Dry-run preview

```bash
npm run go -- mymodule --dry-run
```

Prints what the auto-runner *would* do — useful to see the queue before committing budget.

### Bug-fix cycle

```bash
# 1. After QA finds bugs, write the report
code projects/mymodule/.guide/bugs-round-1.md
# (use prompts/bugs-template.md as a template)

# 2. Detect and plan fixes (one-shot)
npm run bugs -- mymodule

# 3. Auto-run the fixes
npm run go -- mymodule

# 4. After fixes done, re-test workspace/
# 5. Loop: bugs-round-2.md, npm run bugs, npm run go
# 6. When clean: npm run qa -- mymodule --shipped
```

### Audit → bugs → fixes in one shot (`--auto`)

The loop above is three manual steps: audit, promote the findings, run the
fixes. To collapse them into one, pass `--auto` (alias `--chain`) to an audit:

```bash
npm run audit -- mymodule --auto
```

or from Telegram:

```
/run mymodule audit --auto
```

This runs the audit, promotes its "Promote to bugs-round-N" section into a fresh
`bugs.md`, then runs that round **unattended** — generating the fix plan and
executing every fix with no further prompting. It stops only when:

- the round **completes** — you get the normal QA / ship / next-round actions
  (no Resume button, because there is nothing to resume); or
- it hits a **blocker** — a phase/fix error or a budget pause — at which point it
  pauses and offers Resume, so you can fix the blocker and continue.

**Repeat the whole pipeline N times** with `--rounds N` (max 10):

```bash
npm run audit -- mymodule --auto --rounds 3
```

or from Telegram, tap **🔍 Audit** and choose **Auto ×1 / ×2 / ×3 / ×5** (no flag
needed — the button asks). Each round re-audits the now-changed workspace, promotes
the new findings, and runs the fixes. The loop stops early the moment an audit comes
back clean — so "×3" means *up to* three rounds; if round 2's audit finds nothing to
fix, it stops there. A blocker in any round also stops the loop (with Resume). Each
round is a full audit + fix cycle, so ×3/×5 consume real budget — budget pauses still
halt the loop.

A **clean audit** (no actionable findings, or a template the promoter can't
parse) does *not* invent an empty round: the chain stops with
`✓ Completed — chain stopped: <reason>` and the manual Promote action, so a
0-finding audit still means "tighten the brief", not "there's a round to run".

#### Convergence detection — when a recurring finding means "stop", not "retry"

The `--rounds N` / `--auto ×N` loop above is bounded by `max_chain_rounds`
(default 25), but a round count alone can't tell "still making progress" from
"burning rounds against a fix that isn't landing." Every promote parses the
round's `### Bug #N — <title>` findings and compares each one — by title
similarity (Jaccard on lowercased title tokens) and shared affected files —
against every finding from **every prior round**, recorded in
`.guide/audits/finding-history.jsonl`. A finding is "recurring" when its title
overlaps a prior finding by ≥60%, or it shares an affected file with a prior
finding whose title overlaps by ≥40%.

When a round's recurring findings hit `auto_run.convergence.stall_min_recurring`
(default 2), **or** a single finding has now recurred across 3+ total rounds,
the chain **stalls**:

- The round's `bugs.md` is still written in full — the findings are real —
  and gets a `## ⚠ Recurring findings (convergence warning)` section listing
  each recurring finding and which prior round it matches.
- **No fix round runs against it.** `job-runner`'s chain loop stops with a
  `convergence stall — N finding(s) recurring across rounds: ...` reason
  instead of the usual "promoted → running fixes" message.
- If the stall is detected outside the chain (FR20's post-action auto-promote,
  e.g. during a plain `go`/`resume`), the auto-run **pauses** with the same
  reason (`pause_kind: convergence-stall`) instead of silently continuing.

This is a signal that the fix *approach* needs rethinking, not that the round
needs to run again — re-running fixes against a finding the last full round
already tried to fix and didn't resolve just burns budget. Read the recurring
section in the newly-written `bugs.md`, adjust the approach (or the brief),
then either let a fresh audit re-verify or force through the existing operator
escape hatch:

```bash
npm run promote -- mymodule --force
```

`--force` (the same flag used to re-promote after manually editing an audit)
suppresses the stall for that one promote — the recurring evidence is still
recorded and shown, only the auto-stop is bypassed.

Disable convergence detection entirely (reverts to pre-Phase-43 behavior — no
history file, no stall, promote's return shape unchanged) via
`auto_run.convergence.enabled: false` in `config/defaults.json` or a project's
`overrides`.

Everything happens in `workspace/` on `develop`. Nothing is shipped to `main` —
review on GitHub and run `/ship` (or `npm run ship`) when you're satisfied, exactly
as in the manual flow.

To make this the default for a project (no flag needed), set
`auto_run.chain_audit_to_bugs: true` in its `project.json` (or globally in
`config/defaults.json`). Leaving it `false` (the default) keeps the three-step
manual flow.

### Full pipeline (`pipeline`) — intake → build → fixes → ship-ready

The audit auto-pipeline above handles "find bugs and fix them." The **full
pipeline** chains the whole lifecycle in one command:

```bash
npm run pipeline -- mymodule                    # full run, 1 audit→fix round
npm run pipeline -- mymodule --rounds 3         # up to 3 audit→fix rounds
npm run pipeline -- mymodule --stop-after build # brief + plan + phases, then stop
```

From Telegram, tap **🚀 Full pipeline** in the project view and choose
**Full ×N / Build only / Brief only**.

Stages, in order (each conditional on state):

1. **intake** — promote any `scope=now` requirements (auto-scoped) into
   `raw-thoughts.md`; roadmap items dumped to the inbox flow through here too.
2. **brief** — authored only if missing, or if intake added new requirements.
3. **build** — `autoRun` (auto-plans if there's no plan, then runs phases,
   reviews, and any pre-existing bug rounds), unattended.
4. **fixes** — drain the bug inbox (each batch → a round → fixes), then
   audit → promote → fixes, repeated until an audit comes back clean or `--rounds`
   is hit.
5. **QA handoff** — generate the tester doc.
6. **stop at the ship gate** — the pipeline is done; review and `npm run ship`.

What it deliberately does **not** do:

- **It never ships.** Shipping pulls changes into the live install — that stays a
  human decision. The pipeline ends at a ship-ready state on `develop`.
- **It never spins off new projects** from roadmap items (that needs a name and
  profile); roadmap items go to the requirements inbox instead.
- **It won't build on an unreviewed brief.** If the pipeline has to author a brief
  *from scratch* (none existed), it stops after writing it so you can review
  `.guide/brief.md` before it builds. A pre-existing brief flows straight through.
  Pass `--auto-brief` to bypass this gate and build on the freshly-authored brief.
- **It stops at the first blocker** — a build or fix run that fails or pauses on
  budget / a failed validator / mid-build, or a git divergence on the workspace —
  and surfaces it (Resume for build/fix blockers; reconcile guidance for git).

`--stop-after brief|build|fixes|qa` lets you validate incrementally (run
`--stop-after build` first to confirm the build is healthy before letting it
audit-and-fix unattended) and gives you a brief-review gate (`--stop-after brief`).
Because every round is a full Claude run, a long `--rounds` value consumes real
budget; budget pauses halt the pipeline.

### Brief conformance gate (before `ready-for-qa`)

When the last phase completes, before the project flips to `ready-for-qa`, the
auto-runner runs a **brief conformance check** (`src/lib/brief-conformance.js`):
one fresh, read-only Claude pass that grades every brief FR and Definition-of-done
item against the code as committed. It's the back-of-pipeline complement to the
plan-coverage gate that runs *before* phase 1 — plan-coverage asks "does every FR
map to a plan phase?", conformance asks "does the code actually satisfy every FR?".

- Any FR marked **missing** becomes a deduped `bug_inbox` row (severity `major`)
  and the run **pauses before `ready-for-qa`** instead of setting it — the pause
  reason names the missing FR ids and points at `.guide/brief-conformance.md`.
  `partial` items never block; they're surfaced in the matrix for the tester.
- The check is **re-fired only when the active brief's content hash has moved**
  since the last `.guide/brief-conformance.json`, so an unchanged brief never
  re-spends the call, and a forced re-run never duplicates bug rows.
- If the checker can't produce a valid verdict (spawn failure / invalid JSON after
  one re-ask), the verdict is stamped `inconclusive`; `brief_conformance.fail_open`
  (default `true`) does **not** block on that — same philosophy as `verify.fail_open`.

Turn it off with `brief_conformance.enabled: false` (byte-identical to the
pre-gate straight-to-`ready-for-qa` path). See `config/defaults.json` →
`brief_conformance` for `block_on_missing` / `fail_open`.

### Status

```bash
npm run status                  # all projects + window
npm run status -- mymodule      # one project + phases + bug rounds + last run
```

## Checkpoint configuration

In `config/defaults.json`:

```json
{
  "auto_run": {
    "auto_pause_after_phase_1": true,      // foundation check
    "auto_pause_after_review": true,        // every review
    "auto_pause_after_final_phase": true,  // before declaring done
    "auto_pause_after_phases": [],          // custom (per project)
    "auto_pause_on_error": true,            // ALWAYS true recommended
    "auto_pause_on_budget_warn": false,     // pause at warn (not just pause threshold)
    "max_phases_per_run": 50,               // safety cap
    "delay_between_calls_ms": 2000          // breathing room
  }
}
```

Per-project override in `projects/&lt;name&gt;/project.json`:

```json
{
  "overrides": {
    "auto_run": {
      "auto_pause_after_phases": [5],
      "auto_pause_after_phase_1": false
    }
  }
}
```

### Intent-based checkpointing (`auto_run.checkpoint_policy`)

The count-based checkpoints above pause a 3-phase tweak as often as a 40-phase
build. `checkpoint_policy.mode` replaces that all-or-nothing switch with three
strategies (default `all` — byte-for-byte the pre-phase-64 behavior):

| mode | pauses on |
|------|-----------|
| `all` (default) | every configured `auto_pause_after_*` checkpoint + error + budget |
| `intent` | ONLY before a phase whose plan `checkpoint` tag is in `pause_intents`, + error + budget (the count-based phase-1/final/custom and review/fix checkpoints don't fire) |
| `errors-only` | phase error + budget ONLY (every completion checkpoint, incl. final, is skipped) |

Error and budget pauses are identical across all modes, and **unattended mode
wins over any mode** — its behavior is unchanged. The guide tags each phase in
`plan.json` with a `checkpoint` intent: `architecture`, `schema`,
`external-integration`, `destructive`, or `routine` (missing/legacy/unknown →
`routine`, which never pauses). In `intent` mode the run stops *before* a phase
whose tag is listed in `pause_intents` (default `["architecture","destructive"]`).

```json
{
  "overrides": {
    "auto_run": {
      "checkpoint_policy": { "mode": "intent", "pause_intents": ["architecture", "schema", "destructive"] }
    }
  }
}
```

Set it from chat with the `set_checkpoint_policy` tool (validates the mode/intents
and writes the override), or edit `project.json` directly. The active policy is
shown in the run header (`describeCheckpoints`) and the web ConfigTab.

**Layer 1 — `auto_pause_after_phase_1_min_total_phases`** (deterministic, applies
under mode `all`): skip the phase-1 checkpoint when the plan has *fewer* than
this many phases, so a short plan doesn't stop for a foundation check it doesn't
need. Default `0` never skips.

```json
{ "overrides": { "auto_run": { "auto_pause_after_phase_1_min_total_phases": 5 } } }
```

## Acceptance verification (`verify.*`)

After each phase's dev agent commits and the validator gate passes, a second, independent
Claude call ("the checker") grades the diff against `plan.json`'s `acceptance_criteria` — a
check on what the dev *claims* vs what the code *actually does*. See `docs/VERIFY_LOOP.md` for
the full design and `docs/ARCHITECTURE.md`'s "Acceptance-check verify loop" section for the
implementation.

Controlled by `verify.mode` in `config/defaults.json` (or per-project `overrides.verify.mode`):

- **`"report"`** — the verdict is recorded (`verify.json` next to the phase report) and
  logged, but never blocks. Use this to build confidence in checker precision before switching to
  `"gate"`.
- **`"gate"`** — a failing verdict triggers **one targeted refine** (bounded by
  `verify.max_refine_attempts`, default 2): the dev session is resumed with the verdict's
  `must_fix` list injected ("fix EXACTLY these items — nothing else"), the validator gate re-runs
  on the new diff, then the checker re-checks with a fresh session. If it's still failing once the
  refine budget is exhausted, the phase/fix **fails** exactly like a validator-gate failure — the
  commit stays local (never pushed), and the failure flows into the normal
  timeout/heal → Opus-escalation → pause chain (see below) with zero special-casing.
- **`"off"`** — the checker never runs.

`verify.cadence` controls when the LLM checker runs for numbered phases. The
default `mode: "every-phase"` preserves the established behavior. The bundled
`development-focused` profile selects `mode: "checkpoints"`: deterministic
validators still run on every commit, while LLM acceptance runs every third
phase and always on final, high/critical, architecture, schema,
external-integration, and destructive phases. Fix cadence is unchanged.

```json
{
  "profile": "development-focused"
}
```

Profiles resolve before `project.overrides`, so a project can raise/lower the
cadence deliberately. Keep `phases.review_every_n_phases` reasonably close to
the checker cadence; setting it to a very large number removes the periodic
review backstop and is not recommended for this profile.

### What happens at a turn or provider limit

- `error_max_turns` ends one CLI call, not the phase. The orchestrator resumes
  the same Claude session with `phases.max_turns_continuation` and continues
  from its unfinished point.
- A five-hour or weekly account usage limit rejects every new Claude message,
  so a final “summarize your findings” chat cannot run after the limit. The
  provider result's session ID is persisted; the run pauses, the watchdog waits
  for reset, and the phase resumes that exact session automatically.
- If the interrupted call already wrote its commit and completion report, the
  next run skips a duplicate dev spawn and replays the normal validator and
  acceptance gates against that commit before recording completion.

A phase with no `acceptance_criteria` listed in `plan.json` skips the checker by default
(`verify.skip_when_no_criteria`) — goal-only phases are graded by the periodic 3-phase review
instead. Fix verification defaults to `verify.include_fixes: "major+"` (critical/major fixes;
minor fixes skip); bugs.md's acceptance criteria supply the fix checker input.

## Concurrent mid-stream reviews (`auto_run.async_reviews`)

Every `phases.review_every_n_phases` (default 3), the guide runs a review of the
phases since the last one. By default this review is fully **synchronous**: phase
N+1's dev call waits for the review's verdict (~5 minutes) before it can start,
even though the review is advisory (its BLOCKER/score verdict only ever affects
*whether the run pauses*, never the code the dev already wrote).

Setting `auto_run.async_reviews: true` (default `false`) fires a **mid-stream**
review (never the final review before QA — that one always stays synchronous)
without awaiting it, so phase N+1's dev dispatches immediately instead of
blocking on the verdict:

- The review reads a **worktree pinned to phase N's own commit**
  (`git worktree add --detach`, resolved via the phase's `phase-N:` commit
  message, falling back to the live HEAD if that lookup ever misses) — so it
  never observes phase N+1's (or N+2's) still-in-flight changes. The pin skips
  git preflight/sync entirely (it's a read-only, detached, point-in-time view)
  and is removed once the review settles.
- At most one review runs in the background at a time (cap 1) — if a second
  review comes due before the first settles, the run waits for the first to
  finish before firing the next.
- A non-review guide action (audit, bug-plan, plan, lessons-distill, …) always
  waits for an outstanding background review to settle first — those tasks can
  read `decisions.jsonl` or the review file the background review is still
  writing.
- The verdict, once the review settles, gets the exact same handling a
  synchronous review would: a `BLOCKER` line or a score under
  `auto_run.review_auto_proceed_score_threshold` pauses the run (via the same
  `auto_pause_after_review` checkpoint); a passing score auto-proceeds. The
  **only** difference is *when* that pause can happen — one phase later than
  today, since phase N+1 (or further) may already have dispatched by the time
  phase N's verdict comes back.

**Known trade-offs — read before enabling on a project:**

1. **Phase N+1's prompt misses phase N's review decisions.** A review may
   append conventions/decisions to `decisions.jsonl` as part of its verdict;
   phase N+1's dev prompt is already assembled (and may already be running) by
   the time those entries land. This is the same lag that already exists
   *inside* a single 3-phase review batch today (phase N+1 never waits on
   phase N's review even in the synchronous path) — async reviews just extend
   that same lag by one more phase in the rare case a BLOCKER surfaces late.
2. **The overlapped phase's push is not held.** Phase N+1 (and its
   commit/push) proceeds normally while phase N's review is still running —
   a BLOCKER verdict pauses the run, but it does not (and cannot) unwind work
   already pushed by an overlapping phase.

Because it changes pause *timing*, `async_reviews` defaults to `false` and
should be enabled per-project (`overrides.auto_run.async_reviews: true`) only
after confirming one clean synchronous run on that project.

## Speculative phase scout (`phases.scout`)

A dev call runs 10-30 minutes; a Haiku call runs a few. `phases.scout`
(default `{ enabled: false, max_staleness_pct: 30 }`) uses that idle time to
speculatively map the **next** phase's likely files while the **current**
phase's dev agent is still working — a fresh, read-only, roleless (`role:
null`, `sessionId: null`) Haiku call, never resumed, never escalated.

**Why it ships off by default:** dev spawns already receive the full
deterministic repo map (`repo_map.*`). The scout's only incremental value is
*why-relevant* annotation on top of that map for the specific next phase —
unproven until measured against calls-table cost. Enable per-project
(`overrides.phases.scout.enabled: true`) only after confirming the annotation
is worth the extra Haiku call.

When enabled, for every `'dev'` action whose plan has a phase after it with no
scout note already on disk:

- The auto-runner fires `spawnPhaseScout` **concurrently** with the dev action
  itself (`Promise.allSettled` — a scout failure, timeout, or empty reply
  degrades to a dim log and simply means no note gets written; it can never
  affect the dev result).
- The scout reads a **worktree pinned to the pre-dev HEAD** (resolved before
  the dev call starts, so it's a consistent point-in-time tree, never the live
  workspace the dev agent is mid-editing) with a read-only tool sandbox
  (`verify-loop.js`'s `CHECKER_ALLOWED_TOOLS` — no Write/Edit/unrestricted
  Bash). Its prompt is the next phase's plan spec (goal, acceptance criteria,
  files expected) plus instructions to reply with exactly three sections:
  `## Files` (5-15 repo-relative paths, one per line, each with a one-line
  why-relevant reason), `## Patterns to follow`, and `## Integration points`.
  No code, no tests, no fixes.
- Because the scout's sandbox has no Write tool, the **orchestrator** persists
  its reply to `.guide/phase-<n>-scout.md` with a `base_sha` front-matter
  stamp — the same "checker can't write, orchestrator persists" pattern
  `verify-loop.js` uses for `verify.json`.
- When that phase's dev prompt is built (the very next inline phase prompt),
  the note is read, staleness-checked, and injected under the header
  `Advance scout notes (computed at <sha8>, one phase ago -- verify before
  relying on them; files may have moved):` — then **deleted** (consume-once;
  it is never read twice). A note whose `## Files` paths have more than
  `max_staleness_pct`% changed since `base_sha` (or whose `base_sha` is
  unresolvable/unparsable) is dropped and deleted instead of injected, with a
  dim log line.
- Scout notes are advisory prompt content only — never routing input, never a
  completion requirement, never something a phase can fail for lacking.

## Parallel phase waves (`auto_run.max_parallel_phases`)

By default (`max_parallel_phases: 1`) phases run strictly one at a time — the
serial path, unchanged, and **no lane-manager code is ever touched**. Set
`max_parallel_phases` above 1 and the auto-runner MAY run a **wave** of
independent, ready phases concurrently in isolated git-worktree **lanes** (see
`src/lib/lane-manager.js`), then merge them back **strictly ascending**,
degrading to serial on the first failure or conflict.

**What can go in a wave (every guard shrinks it; any miss ⇒ wave of 1 = serial):**

- **Ready set.** `pickReadyPhases` returns every pending phase whose *effective*
  dependencies are all completed **in the phases table**. "Effective" reuses
  `resolveEffectiveDependsOn` (plan-validate.js) — an explicit `depends_on` wins,
  otherwise the implicit previous-plan-entry chain. So a plan with no
  `depends_on` is fully serial; a plan where phases 2 and 3 both depend only on 1
  makes {2, 3} ready together once 1 completes.
- **`max_parallel_phases`** caps the wave width.
- **A clean plan DAG.** `validatePlanStructure` must report zero problems, else
  serial fallback.
- **No boundary crossing.** A wave never extends past a review-cadence phase
  (`n % review_every_n_phases === 0`), the final phase, a custom
  `auto_pause_after_phases` entry, or a checkpoint/pause phase (the phase-1
  checkpoint under `checkpoint_policy` mode `all`, or the phase before a
  `pause_intents` checkpoint under mode `intent`). Such a phase may be a wave's
  **last** member, but nothing after it joins the same wave.
- **In-code file disjointness.** `files_expected` is treated as a
  **non-authoritative LLM estimate**: the scheduler intersects file lists *in
  code* and stops the wave before any phase whose estimate collides with one
  already in the wave. A guide `independent: true` annotation is **never**
  trusted. Any phase with a missing/empty `files_expected` intersects with
  everything and runs alone (wave of 1).

**Execution (per wave):**

1. The guide `next-prompt` (if any) runs **serially first** — the guide session
   is singular and is *never* parallelized.
2. One lane per wave phase, all branched off the **same** pre-wave workspace
   HEAD. Each lane runs `runDev({ laneMode })` pinned to its own phase, under its
   own per-spawn job key, via `Promise.allSettled`. No new locks: the
   project-level `running_jobs` claim already serializes runs, and all lanes live
   inside that one claim.
3. **Ascending merge of the contiguous successful prefix.** Walk the settled
   lanes low-to-high; for each success, `mergeNoFf('lane/phase-N')`, re-resolve
   the commit via its `phase-N:` message, and run the **one shared**
   `completeMergedPhase` helper (the same one `runDev`'s serial path calls — so
   `current_phase` keeps its meaning of "max contiguous completed n" for free).
4. **One** mandatory validator gate on the merged HEAD, then **one** push per
   wave. A red merged HEAD is rolled back to the pre-wave base (`git reset
   --hard`) and never pushed.

**Failure semantics (the prefix rule):** the **first** failed or conflicted lane
stops the walk and is handled exactly like a serial failure — a dev failure gets
an escalation marker + phase reset to pending; a merge conflict is aborted (`git
merge --abort`), the lane branch discarded, the phase reset pending, and a
`lane-conflict` lesson recorded. Either way that phase re-runs **serially** on
its next pick, through the existing reprompt/escalate/pause ladder (it is not
re-waved). **All later lanes — even ones that succeeded — are abandoned** (reset
to pending, `lane-abandoned` lesson) so the in-order merge is never violated;
they re-wave once the problem phase resolves. A merged-HEAD **gate** failure is
treated as today's validator-gate failure on the **lowest** merged phase:
everything rolls back to the base and re-runs serially.

**Crash safety.** Every lane is torn down in a `finally` (merged → `done`, else
`abandoned`). A run that crashed mid-wave leaves stale `running` lane rows +
worktrees; the next run's **orphan sweep** (`sweepOrphanLanes`, gated on
`max_parallel_phases > 1`) reconciles them to `abandoned` and removes the dirs
before any new wave starts.

Because in-code disjointness is only an estimate, the **ascending-merge conflict
fallback is the real backstop**: two phases whose `files_expected` looked
disjoint but collide on disk simply conflict at merge time and the second one
falls back to serial — correctness never depends on the estimate being right.
`max_parallel_phases` defaults to `1`; raise it per-project
(`overrides.auto_run.max_parallel_phases`) only after a clean serial run.

## Parallel independent fixes (`bug_cycle.max_parallel_fixes`)

The bug-fix analog of parallel phase waves: within one bug round, a consecutive
run of **file-disjoint** pending fixes runs concurrently in lanes instead of one
`fix-dev` call at a time. By default (`max_parallel_fixes: 1`) fixes run strictly
serially — today's exact path, and **no lane-manager code is ever touched**. Set
`max_parallel_fixes` above 1 and `pickBugAction` MAY emit a `fix-dev-batch` action
that runFixBatch fans out across `lane/fix-rR-N` worktrees.

**What can go in a batch (`selectFixBatch`, same skepticism as phase waves):**
starting at `fixes_completed`, take the longest **consecutive prefix** (capped by
`max_parallel_fixes`) of pending fixes whose `files_likely` are **pairwise
disjoint** — intersected *in code*, never trusting a guide "independent"
annotation. A fix with **missing or empty `files_likely` intersects with
everything**: as a batch head it runs alone, and anywhere later it ends the batch.
Fixes in a round frequently share a subsystem, so this intersection **frequently
serializes the batch to one fix — that is correct, not a bug**; the disjointness
check is intentionally strict. Batching is also skipped (classic single fix) when
`fixes.inline_fix_prompts` is off (a batched fix uses runDev's inline prompt).

**The counter is the correctness constraint.** `bug_rounds.fixes_completed` is a
bare `+1` counter used as an **array index** into the round's fix plan, so
recording out of order — or ahead of the fixes that actually committed — silently
corrupts fix dispatch. runFixBatch therefore:

1. Merges the lane branches **strictly ascending** (fix order), stopping at the
   first failed/conflicted lane.
2. Runs the **one** mandatory validator gate on the merged HEAD, then records
   `recordFixCompletion` per merged fix **in ascending order** and pushes **once**.
   Recording is *deferred until after the gate passes*: the counter has no
   decrement accessor, so a red merged-HEAD gate rolls the whole prefix back to
   the pre-batch base (`git reset --hard`) and records **nothing**, escalating the
   lowest merged fix to re-run serially. This keeps `fixes_completed === the count
   of fixes actually committed` under every outcome.

**Failure semantics (the prefix rule).** The first failed or conflicted lane
stops the walk: its fix gets an escalation marker (a conflict also records a
`lane-conflict` lesson) and re-runs **serially** through the existing single-fix
reprompt/escalate/park ladder — it is never re-batched (a `laneFallbackFixes` set
collapses it back to a classic `fix-dev`). **Every later lane — even ones that
succeeded — is abandoned** (torn down, `lane-abandoned` lesson, *not* recorded) so
`fixes_completed` stays contiguous; they re-batch once the failed fix ahead of
them lands. A parked fix (`on_double_failure: 'skip'`) still calls
`recordFixCompletion`, so the counter stays contiguous there too.

**Reconciliation is free.** `fixCommitExists` greps `^fix-rR-N:` commit subjects,
which survive `--no-ff` merges, so a batch that committed but crashed before
recording is reconciled by pickBugAction's existing self-heal walk with **no
change**. `max_parallel_fixes` defaults to `1`; raise it per-project
(`overrides.bug_cycle.max_parallel_fixes`) only after phase waves have soaked —
lanes double in-flight window calls, guarded by the fair-share scheduler.

## Single-call minor-fix batching (`bug_cycle.batch_minor_fixes`)

Cuts spawn count for cheap, independent bugs: instead of one `fix-dev` call per
fix, a consecutive run of **minor-severity, file-disjoint** pending fixes is
executed as **one dev spawn, in the real workspace — never a worktree lane**,
with one commit per fix inside that single call. Off by default
(`batch_minor_fixes: false`); `batch_max` (default `4`) caps the batch size.

**What can go in a batch (`selectMinorFixBatch`):** starting at
`fixes_completed`, take the consecutive run of pending fixes that are all
`severity === 'minor'` (missing/major/critical severity ends the run
immediately — **majors and criticals are never batched**, even mid-run) with
pairwise-disjoint `files_likely`, same in-code intersection discipline as
`selectFixBatch`. Unlike the lane batcher, a fix with missing/empty
`files_likely` is **never added to the batch at all** (not even as a lone
head) — a single-call batch only has value at size > 1, so there is no
"run alone" case to preserve.

**Mutually exclusive with parallel fix lanes in v1.** Single-call batching is
only ever consulted when `bug_cycle.max_parallel_fixes === 1`. If lanes are
also enabled (`max_parallel_fixes > 1`), **lanes win** and single-call
batching is skipped outright — even if that pick's lane-batch selection
collapsed to size 1 — with a dim log naming the deciding config key. This
keeps the two features from ever needing to reconcile a shared failure story.

**One numbered prompt, one spawn.** `buildInlineFixBatchPrompt` extends the
inline fix-prompt convention: each fix gets its own numbered heading, plan.json
entry, and report path; a shared "Rules"/"Commit contract" block (byte-identical
regardless of which/how-many fixes are in the batch) makes the hard requirement
explicit — **one commit per fix, subject `fix-rR-N: ...`, in the given order,
never combined**. `runDev` treats a batch call like a fix for routing/git
purposes but stops right after the spawn and its own no-commit guard — no
escalation/validation marker, no per-fix idempotency shortcut, no push: all of
that belongs to the orchestrator, once, across the whole batch.

**Failure attribution (`runFixSingleCallBatch`).** `preBatchSha` is captured
before the spawn. On a call error **or** a failed merged-HEAD validator gate
(run once, same `gateMergedFixHead` P4 uses, scoped to the whole batch's
diff): the batch's commits are rolled back **only if verified unpushed** via
`aheadBehind` — `ahead > 0 && behind === 0` is the one safe case; a `null`
result (no upstream) or `behind > 0` (diverged — another host pushed
concurrently) is treated as **ambiguous/pushed and the reset is skipped**.
Either way, **no batch-level escalation/validation marker is written** — a
per-round `batch-fallback.md` note plus a `batch-fallback` lesson record the
fallback, and every fix in the batch re-dispatches **individually** next pick
(a `batchFallbackFixes` set, mirroring P4's `laneFallbackFixes`, forces this —
never re-batched).

**On success**, the contiguous committed prefix is reconciled via
`fixCommitExists`, `recordFixCompletion` runs ascending, and there is **one
push**. A green-but-partial batch (the agent stopped partway, or committed out
of order) records only the contiguous prefix and re-queues the rest
individually — graceful degradation, never a stall.

## Speculative opus+fable duo (`auto_run.speculative_duo_on_double_failure`)

The **last resort** before a `force_tier`-critical PHASE pauses for a human. Off
by default (`speculative_duo_on_double_failure: false`) — with it off, a
double-failure pauses exactly as it always has and **zero duo code
(`src/lib/duo-executor.js`) ever runs**. FIXES never duo — they park
(`on_double_failure`) as today; only phases are eligible.

**Trigger — all of the following, checked right where the pause would fire:**

- the action about to pause is a **phase** dev call (never a fix);
- `auto_run.speculative_duo_on_double_failure === true`;
- the phase's routing actually matched a `force_tier` keyword rule (a
  regulatory-core/security-core rule in `config/model-routing.json` — a plain
  complexity-routed opus phase does **not** qualify);
- `windowStatus(cfg)` shows headroom for **≥4 calls** (2 dev legs + 2 judges)
  before `warn_at_calls`.

Any miss falls straight through to today's normal pause — this is a strict
narrowing of the double-failure path, never a new one. The duo also never fires
twice for the same phase in one run (it consumes the phase's terminal retry —
no duo-of-duos), and never fires for a transient (rate-limit/network) failure,
which always retries normally instead.

**Workspace restore.** The failed attempt's commit(s) exist **locally, unpushed**
on the real workspace branch — merging a duo winner on top of them would
conflict or double-apply. Before branching two lanes, `verifyAndRestore` checks
via `aheadBehind` that every local commit ahead of origin is one of *this*
phase's own `phase-<N>:` attempts and nothing has been pushed or diverged; on
anything ambiguous or foreign it **aborts the duo with no reset** (falls
through to a normal pause) rather than risk destroying real work. Otherwise it
`git reset --hard`s the workspace back to origin tip and deletes the phase's
`validation-failed`/`escalate-opus` markers.

**Two legs, one race.** `provisionLane(kind:'duo')` runs twice off that reset
base — `lane/duo-opus` on `claude-opus-4-8`, `lane/duo-fable` on
`claude-fable-5` — via the same lane machinery P3/P4 use, concurrently, each
under its own job key. A **refused** leg (fable declining security/regulatory
content — `stop_reason: 'refusal'`) or an errored leg is a **lost leg**: its
`phase_lanes` row is marked `failed` and the duo continues on the survivor. A
refusal is **never** routed to auto-heal or the escalation ladder. Two lost legs
⇒ pause, exactly like today.

**Judging.** Each surviving committed leg gets its own fresh acceptance-checker
session (`runAcceptanceCheck`, `workspaceDir` = that leg's lane directory).
`decideDuoWinner`: pass beats fail; both pass → fewer unmet criteria wins; an
exact tie → fable wins; nobody passes → no winner, pause (both `verify.json`s
plus a `.guide/phases/<n>-*/duo.json` summary are kept for the human either
way).

**Merge + bookkeeping.** The winner merges via `mergeNoFf`, the merged HEAD gets
the **same mandatory validator gate** P3/P4 run, then the **same**
`completeMergedPhase` helper finishes it — no separate completion path. Exactly
**one** push. Both lanes are torn down in `finally` regardless of outcome
(winner → `done`, loser/lost → `abandoned`/`failed`). `duo.json` is written on
every outcome — merged, both-fail, or aborted — recording both legs' models and
verdicts and which tier won, so a human looking at a paused run can see what was
already tried.

`speculative_duo_on_double_failure` defaults to `false`; enable it per-project
only for projects that actually have `force_tier`-critical phases, and only
after phase waves and fix lanes (the lane machinery it reuses) have already
soaked — see `docs/PARALLEL_EXECUTION.md` for the full enablement order.

## Run event timeline (`run_events`)

Every notable auto-run transition is appended to a `run_events` table so
**"what happened during run N?"** is one query instead of stitching together
`auto_runs.status`, `.guide` verdict files, escalation markers, and
`healing_log`. Rows are `(id, run_id, project, ts, kind, phase, detail)` —
one writer per run (`autoRun()` is one process per project), so ordering by
`id` is authoritative and no sequence column is needed. `detail` is a
JSON string capped at ~2KB.

**Instrumentation, not a control path.** `recordRunEvent(runId, kind, ctx)`
is a synchronous, **never-throwing** insert (a missing `runId` warns and
writes no row; any DB error is caught and logged). A telemetry failure can
never fail a run.

**Documented `kind` vocabulary** (each a one-line call site in
`auto-runner.js`):

| kind | when |
|------|------|
| `run-started` | `autoRun()` begins |
| `plan-created` | a fresh plan is written (`detail.phases`) |
| `phase-started` | a dev phase starts (`detail.phase`) |
| `dev-completed` / `dev-failed` | phase (or fix) dev result |
| `reprompt` | a phase is re-prompted after a failure |
| `escalated` | in-run auto-retry on a higher tier (`detail.targetTier`, `hop`) |
| `heal-attempt` | auto-heal ran (`detail.healed`) |
| `validator-failed` | external validators failed (`detail.summary`) |
| `acceptance-pass` / `acceptance-fail` | the acceptance verdict (`detail.unmet`) — recorded in gate mode inline, in report/async mode on the deferred verify tick |
| `review-verdict` | a guide review scoreline (`detail.score`) |
| `fix-started` / `fix-completed` / `fix-parked` | bug-fix lifecycle (`detail.round`) |
| `audit-completed` | a completion audit pass finished |
| `bugs-promoted` | audit findings promoted to a bug round (`detail.count`) |
| `checkpoint-pause` / `budget-pause` / `run-paused` | the run paused (checkpoint / budget / everything else) |
| `run-completed` | the run finished cleanly |

**Retention.** `cleanup.run_events_retention_days` (default `90`, `0`
disables) bounds the table. The sweep is a best-effort `DELETE` run once per
run during auto-run preflight — scoped to this table, not the server-wide
`log-cleanup.js` sweep, since `run_events` follows `auto_runs`, not
logs/outputs/calls.

**Surfaces.**

- `GET /api/projects/:name/runs/:id/events` — id-ordered rows for one run.
  Returns `[]` for an unknown/legacy run (never 404s on that); `404` only for
  an unknown project.
- The Web UI **Runs** tab renders each run row as an expandable vertical
  timeline (lazy-loaded on expand), reusing the existing status-badge palette.
- The `get_run_timeline` chat tool (`{ project, run_id? }`, default the last
  run) returns the same rows for the chat agent.

Legacy pre-0.18 runs recorded no events — every surface renders **"no timeline
recorded"** rather than erroring.

## Notification outbox (`notify_outbox`) — pings independent of launch surface

Phase pings, drift/reground notices, and pause alerts must reach the phone
regardless of **how** the run was launched. A run started from the Web UI
(`spawnOrchestrator`) or from chat (`spawnDetached`) is a bare detached CLI:
`autoRun()` runs with `notifier: null`, so every `notifier.notify(...)` site was
previously a silent no-op for those launches. Only job-queue runs (Discord/
Telegram `/run`) carried a live notifier and actually pinged.

**The fix: a durable outbox.** Every run-lifecycle notice funnels through
`queueNotify({ project, text, replyMarkup })` in `state.js` — a synchronous,
**never-throwing** insert into `notify_outbox` `(id, project, text,
reply_markup, created_at, delivered_at, attempts, status)` that returns the new
row id (or `null` on missing text / DB error). This runs **unconditionally**,
so the notice is durably recorded even when no notifier is in scope.

- **Fast path (live notifier present).** `auto-runner.js`'s `queueAndNotify()`
  queues the row, then — if a notifier is in scope — calls `notifier.notify`
  and, on success, `markOutboxDelivered(id)` in the same tick. The delivery
  loop selects `status = 'pending'` only, so a fast-path-delivered row is never
  re-sent.
- **Fallback deliverer.** `server-discord.js` (the active bot) runs a **10s**
  `setInterval` delivery loop (`startNotifyOutboxDelivery`, beside the watchdog
  and operator-questions pollers). Each tick takes the oldest ≤20 `pending`
  rows, `Notifier.notify`s each, and sets `delivered_at` on success. On failure
  it increments `attempts`; at **5** failures the row flips to
  `status = 'failed'` and drops out of the pending set. A resolved-but-
  unreachable delivery (`{ total > 0, delivered: 0 }`) counts as a failure so a
  transiently-offline phone retries rather than losing the ping. This is the
  only path that gets bare-CLI-launched pings onto the phone.
- **Pause alerts.** `finalize()` queues a pause ping **only when there is no
  live notifier** — job-queue runs already get a richer pause ping (with a
  next-actions keyboard) from `job-runner.js`, so queueing there too would
  double-ping.
- **Web mirror (read-only).** The global SSE tick tracks the last-seen outbox
  id and emits each new row once as `{ type: 'notify', project, text }`;
  `Toasts.js` surfaces it as a toast. The browser **never** marks a row
  delivered — delivery to the phone is `server-discord.js`'s job alone.

Single-deliverer semantics are first-claim-wins if multiple bot processes ever
run; there is no per-channel fan-out. Legacy rows are unaffected — the table is
created idempotently and starts empty.

## Structured failure autopsy (`models.autopsy`)

When a run ends at its **highest-friction** terminal state — an outright
`failed`, or a pause on a **phase error** (`mid-build`) or a **failed
validator** (`validator-failed`) — a single line of `pause_reason` is rarely
enough to decide what to do next (you're often reading it on a phone). At that
moment `finalize()` fires a **structured autopsy** (`src/lib/autopsy.js`),
best-effort and **after** status is already persisted, so it can never change or
block the run's outcome.

`assembleAutopsyContext({ projectName, runId })` is **deterministic** (no LLM):
it gathers the run row's `pause_reason`/`pause_kind`, the run's `run_events`
timeline, errored `calls` in the run window, `healing_log` attempts since the
run started, the latest `verify_results` verdict counts, and the last ~30 parsed
log-tail entries. `runAutopsy` then makes **one** Haiku call (`models.autopsy`,
default `claude-haiku-4-5`) — roleless/sessionless, tool-less (`JSON`-only
reply), with a **byte-identical static instruction block** across calls (all
volatile context, including the enumerated allowed next-actions, rides the user
prompt). The reply is validated to
`{ what_ran, what_failed, what_was_tried, root_cause_hypothesis,
recommended_action, confidence }`, where `recommended_action` **must** be one of
the exact commands `getNextActions` offers for this state; one re-ask on invalid
JSON, then it falls back.

**Budget guard (mandatory).** If the billing window is `pause` (or the call
fails, or the reply is still invalid after the re-ask), the autopsy is emitted as
a **plain-text deterministic** summary with **no** LLM call at all. The path
**never throws** — every failure mode degrades, so autopsy trouble can never fail
a run. The whole call is awaited under `phases.task_timeout_ms.autopsy`
(120 s) with `phases.task_max_turns.autopsy` = 4.

**Outputs:** `auto_runs.autopsy` (the JSON), `.guide/autopsies/run-<id>.md` (the
full markdown), a ≤6-line `queueNotify` ping **leading with the recommended
action**, and one `openIssueThread({ kind: 'autopsy', … })` (6 h dedupe) so the
chat agent can pick it up. Legacy runs (and every non-error terminal state —
clean completion, budget pause, checkpoint pause, cancellation) get **no**
autopsy.

## Nightly portfolio autopilot (`autopilot.*`)

The watchdog (`src/lib/project-watchdog.js`) only auto-*resumes* recoverably-paused
runs. The **portfolio autopilot** goes further: on idle overnight windows it picks
the highest-value work across *all* projects, enqueues it, and mails you a morning
digest — so the fleet moves while you sleep instead of the window expiring unused.
**Default OFF** (`autopilot.enabled: false`) — unattended fleet execution is opt-in.

**Config** (`config/defaults.json`, top-level `autopilot`):

| key | default | meaning |
|---|---|---|
| `enabled` | `false` | master switch; false → the scheduler never registers a timer |
| `start_hour` | `1` | local hour the plan+execute pass runs |
| `digest_hour` | `8` | local hour the morning digest runs |
| `max_projects_per_night` | `3` | cap on DISTINCT projects touched in one night (one action each) |
| `priority_order` | `["resume","brief","bugs","audit","suggestions"]` | which action a project takes when several apply, and the packing order across projects |
| `require_operator_approval_for` | `["brief"]` | actions that need a valid, unexpired standing approval before `execute()` will enqueue them |

**Nightly pass** — `startAutopilot({ cfg, notifier })` follows the `startWatchdog`
pattern and starts where the watchdog starts (Telegram/Discord servers). At
`start_hour` it gathers portfolio state → `plan()` (pure, budget-packed, capped at
`max_projects_per_night`, always leaving P2's `billing.window_headroom_min_calls`
margin) → `execute()` (enqueues via the existing job queue only — no new spawn
path). It runs **at most once per calendar night**: `last_planned_date` on the
singleton `autopilot` table makes a mid-night restart a no-op, never a double-plan.

**Approvals** — an autonomous overnight **brief** is the one action never run
silently. It enqueues only against a **valid, unexpired standing approval**
(`ashmero autopilot approve <project> <action> [--nights N | --until <ts>]`), which
is consumed for that night; once exhausted the action reverts to a digest
**recommendation**. Every approval carries an expiry — it is never a permanent
silent bypass.

**Fail closed (hard requirement)** — if brief 04's deny-rule sandbox
(`security.deny_rules` + `src/lib/workspace-skills.js`'s `mergeDenyRules` /
`PUSH_DENY_RULE`) is **not resolvable at load time**, `startAutopilot` **no-ops**
(registers no timer) and `runNightlyPlan` returns before `execute()` — **nothing is
enqueued**. Unlike the digest's notify-outbox fallback, there is NO fallback here:
unattended overnight jobs must never run under unrestricted Bash.

**Morning digest** — at `digest_hour`, `composeDigest` (deterministic) reports what
**ran**, **finished**, **paused** (and why), what **needs approval**, and
recommended next commands, from `auto_runs` + `healing_log` + `tg_jobs` rows since
the night start. An optional single haiku polish (`autopilot-digest`,
`claude-haiku-4-5`) tightens the prose only when it exceeds ~30 lines, and fails
open to the deterministic text. The digest is delivered **through `notify_outbox`**
(the same durable ping path as the rest of the orchestrator), falling back to the
plain notifier only if the outbox is genuinely unavailable. It fires at most once
per calendar day (`last_digest_date`).

> **Runtime QA** (`runtime-qa.*`, P5) is now WIRED into the completion flow
> (`auto-runner.js runReadyForQaRuntimeGate`, phase 89). Before **every**
> `ready-for-qa` transition — the two all-phases-complete sites and the
> fix-round-complete site — it runs `runRuntimeQa` **once per run**, boots and
> exercises the built app, logs the verdict, emits one notifier line, and writes
> `.guide/runtime-qa.json`. In the default **report** mode it is **fail-open**:
> whatever the verdict, the run still reaches `ready-for-qa`. In the default-off
> **gate** mode a verdict carrying blockers auto-promotes them to `bug_inbox` and
> **blocks** the transition with a `runtime-qa-blockers` pause. It routes through
> the *same* brief 04 sandbox and, like the autopilot, **fails closed** (skips,
> no Bash spawn) when that sandbox is absent — a skip never blocks. See the
> **Runtime QA agent core** section in `ARCHITECTURE.md` for the full contract.

**Self-hosted keystone** — `node scripts/verify-autopilot-e2e.mjs` drives the whole
loop end-to-end unattended against an isolated `DB_PATH`: a fixture project with a
queued brief → tick (injected clock) → `plan()` emits → `execute()` enqueues → the
job-runner processes it → a digest row lands in `notify_outbox` (fake-runner seam
so no live Claude call; the header documents the real invocation).

## Pre-flight run forecast (`forecastRun`)

`predictUpcoming` sizes the *cost* of the upcoming work but never asked the one
question that decides whether to start now: **will this run fit the live
5-hour billing window, or burn half of it and pause mid-phase?**
`forecastRun(projectName)` (`src/commands/predict.js`) answers it —
**deterministically, with zero Claude calls** anywhere in the path.

**Inputs:** `predictUpcoming`'s units in execution order (dev-execution **plus
the per-phase acceptance-check call** when `verify.enabled` — the unit builder
counts it so the walk isn't fooled into thinking a `go` run is dev-only — plus
reviews), the `callsInLastHours(5)` timestamps, and `windowStatus(cfg)`'s
heavy-equivalent admission-unit pause threshold plus cost telemetry. Cost is
an enforced threshold only when `billing.enforce_cost_thresholds:true`.

**The walk (pure `simulateForecast`):** advance a simulated clock by each
unit's historical avg `duration_ms`; at each step reclaim window attempts whose
`started_at + 5h` has passed using their heavy-equivalent weight; spend
`task-weight × (1 + historical-per-task-error-rate)` admission units (and the
matching cost) per unit. Normal/unknown tasks weigh `1`; configured bounded
helpers use `billing.heavy_call_lease.cheap_call_weight` (default `0.25`). It
pauses when the admission-unit threshold would be crossed. If explicit cost
enforcement is enabled, the cost threshold participates as a second bound;
otherwise estimated dollars remain monitor-only and cannot stop development.
Raw attempts remain available separately in the forecast/window objects.

**Output** (the same object `GET /api/projects/:name/forecast` and the
`forecast_run` chat tool return verbatim):

```
{ fitsInWindow, pauseAtUnit, pauseAtPhase, pauseReason, etaMs,
  callsShort, costShort, waitForFullFitMs,
  recommendation,     // 'run-now' | 'run-partial-then-pause-at-<phase>' | 'wait-<N>m'
  lowConfidence,      // true when the history is fallback-based (cold project)
  reclaim, … }
```

`waitForFullFitMs` is the smallest delay after which the **whole** run fits
(from the window shedding calls); `null` when the run is bigger than a single
window and no wait helps.

**Where it surfaces (each thin, all best-effort):**

- `GET /api/projects/:name/forecast` and the `forecast_run` chat tool.
- The web **Go / Resume** buttons show a confirm line from it *before* spawning;
  `toolStartRun` appends the one-liner to its reply.
- One forecast line in the auto-run pre-flight log.
- `WindowGauge.js` renders a reclaim line — `↺ +3 units (12 attempts) reclaim in 48m` — from
  `windowStatus().reclaim` (`summarizeReclaim` in `billing-guard.js`).
- The per-phase completion ping appends
  `window: 31 units left — run needs ~18 more, will pause at phase 9` **only** when
  the remaining run won't fit.
- `scripts/launch-with-retry.mjs` sleeps `waitForFullFitMs` up front (capped at
  6 h) so an unattended launch runs clean instead of pausing mid-phase; the
  existing 5-minute rate-limit poll stays as the fallback.

Cold projects with no telemetry come back `lowConfidence: true` and every
surface labels the numbers a *rough estimate*.

## Failure modes & recovery

### Phase reports `is_error: true`

Auto-runner pauses. Read the phase report at `.guide/phase-N-report.md` for the dev's failure description. Options:

1. **Fix the prompt** — edit `.guide/phase-N-prompt.md`, delete the phase report, run `npm run next -- &lt;project&gt;` manually to retry just that phase.
2. **Adjust the plan** — edit `.guide/plan.json`, then `npm run resume`.
3. **Abort** — `npm run abort -- &lt;project&gt;`. Won't roll back code already committed.

### Budget hit

Auto-runner pauses cleanly. The 5-hour window resets automatically. After reset:

```bash
npm run status   # confirm calls dropped
npm run resume -- <project>
```

### Guide context overflow

Three separate mechanisms exist today — do not confuse them:

1. **Manual handoff (human-triggered).** If reviews start producing low-quality output (sign the guide is
   hitting context limits), trigger a handoff by hand:

   ```bash
   npm run handoff -- <project>     # current guide writes handoff.md
   npm run resume -- <project>      # fresh guide picks up
   ```

2. **Automatic compaction (token-based, Phase 31).** `config/defaults.json`'s
   `phases.handoff_when_context_tokens_exceed` (default 150000) is now a live trigger, not dead config.
   After every resumed guide call, the orchestrator checks the LAST assistant turn's per-request context
   size (`input_tokens + cache_read_input_tokens + cache_creation_input_tokens` from that turn's own
   `message.usage` — never the final result event's cumulative `usage`, which sums every turn in the whole
   resumed session and would fire on every call). Past the threshold, it generates a handoff, clears the
   session, and the next call starts fresh from that handoff — no operator action needed. At most one
   compaction per session-id crossing (`metadata_json.last_compact_session_id`). A handoff task never
   triggers itself, and a bad (non-numeric) threshold value logs a `[context-compaction]` warning and
   disables the trigger; `0`/`false` disables it silently (an intentional opt-out).

3. **Automatic re-ground (commit/drift-based, Phase 22).** Independent of token count entirely — every
   guide call diffs the workspace HEAD against the guide's own last-seen commit
   (`metadata_json.last_guide_head_sha`). Below `guide_reground.after_commits`/`after_external_files`
   (defaults 15 commits / 10 external files), the guide session still resumes but is told what moved via
   an injected delta block. Past either threshold, the orchestrator automatically generates a handoff,
   clears the session, and starts the next call fresh from that handoff — no operator action needed. A
   `↺ Guide re-grounded for {project}: {reason}` line is logged and pushed to Telegram (distinct `↺` glyph
   from the plain `⚠` external-drift notice). Never re-grounds twice for the same drifted HEAD
   (`metadata_json.last_reground_sha`). Disable via `config/defaults.json`'s `guide_reground.enabled: false`.
   See `docs/ARCHITECTURE.md`'s "Guide re-grounding on large external drift (Phase 22)" for the full
   mechanism.

   Mechanisms 2 and 3 both reuse the SAME two primitives (generate a handoff, clear `guide_session_id`) —
   they are two independent triggers on those primitives, not competing implementations. If both would
   fire on the same call, the drift-based reground (mechanism 3) runs first and wins the Telegram notice;
   compaction only reports its own notice when the reground didn't already fire one. See
   `docs/ARCHITECTURE.md`'s "Guide session compaction on token overflow (Phase 31)" for the full mechanism.

### Stale fix plan

If you edit `bugs-round-N.md` after `npm run bugs` already ran:

```bash
# Delete the stale fix plan
rm projects/<name>/.guide/fix-plan-round-N.json
rm projects/<name>/.guide/fix-plan-round-N.md
# Re-run
npm run bugs -- <project>
```

## Token budget guidance for `--unattended` runs

Rough estimates (varies wildly with project size):

| Module size | Calls | Time | Risk |
|-------------|-------|------|------|
| Small (3-4 phases) | ~10-12 | 30-60 min | Low |
| Medium (5-6 phases) | ~15-20 | 1-2 hours | Medium |
| Large (7-8 phases, like BillFlow TDS) | ~22-30 | 2-3 hours | Higher |

A Max 20x window covers ~900 short messages per 5h. Each Claude Code call is multiple "messages" of equivalent budget. Plan for **one large module per window** maximum if running back-to-back.

Run `npm run status` mid-flight to see consumption. The orchestrator pauses before you hit the cliff.
