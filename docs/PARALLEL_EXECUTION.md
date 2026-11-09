# Parallel Execution — Enablement Path

The Execution-DAG cycle (brief `07-execution-dag.md`) added four features — parallel
phase waves, parallel fix lanes, single-call minor-fix batching, and a speculative
opus+fable duo — all shipped **default off**. This is the field guide for turning
them on: in what order, on what to watch before advancing to the next step, and how
to get back to today's exact serial behavior if something looks wrong.

See `docs/AUTO_RUN.md`'s "Parallel phase waves" / "Parallel independent fixes" /
"Single-call minor-fix batching" / "Speculative duo" sections for the full mechanism
of each feature; this document is only the *order* to turn them on in and the
*observables* to check at each step. See `docs/ARCHITECTURE.md`'s "Execution lanes"
and "Speculative opus+fable duo" sections for the underlying `src/lib/lane-manager.js`
/ `src/lib/duo-executor.js` implementation.

## Kill switch — the one thing to remember

With shipped defaults every feature in this cycle is unreachable:

| Flag | Default | Effect at default |
|---|---|---|
| `auto_run.max_parallel_phases` | `1` | phase waves never run — no lane-manager call, ever |
| `bug_cycle.max_parallel_fixes` | `1` | fix lanes never run |
| `bug_cycle.batch_minor_fixes` | `false` | single-call fix batching never runs |
| `auto_run.speculative_duo_on_double_failure` | `false` | a double-failure always pauses; zero duo code executes |

**Reverting is always symmetric.** Set the flag back to its default (or delete the
`overrides.*` entry in `projects/<name>/project.json`) and the very next run is
byte-for-byte serial again — there is no lane, worktree, or DB row left over that
needs manual cleanup (the orphan sweep at run start handles anything a crash left
behind; see the symlink caveat below for the one piece of state that *can* leak
outside a lane's own worktree). `parallel_lanes.dir` / `parallel_lanes.node_modules`
are provisioning knobs only — they have no effect unless one of the four flags above
is actually raised above its default.

## The ordered enablement path

Enable **one step at a time**, on **one project**, and let it soak across several
real runs before advancing. Steps are ordered lowest-risk / smallest blast radius
first.

### Step 1 — baseline (do nothing)

Config: shipped defaults everywhere. Behavior: fully serial, unchanged from before
this cycle. Nothing to observe — this is the state every project starts in, and the
state you can always retreat to.

### Step 2 — `bug_cycle.batch_minor_fixes: true` on ONE project override

**Why first:** the lowest-risk feature in the cycle. Single-call batching runs in
the **real workspace**, never a worktree lane — `src/lib/lane-manager.js` is never
even imported for this path — and it only ever groups **minor**-severity fixes
(majors/criticals are never batched).

- Observable *before* enabling: none — this is the first live step.
- Observable *after* enabling: on a bug round with ≥2 consecutive minor fixes,
  confirm exactly **one** dev spawn ran for the group (not one per fix) and that
  the `bug_rounds` table's `fixes_completed` counter advanced correctly and
  contiguously. Force a red batch (or wait for a natural one) and confirm the
  workspace rolled back to `preBatchSha`, a `batch-fallback` lesson/note was
  recorded, and the fixes re-dispatched **individually** on the next pick —
  never stuck as a batch.

### Step 3 — `auto_run.max_parallel_phases: 2` on a DAG-annotated plan

**Prereq:** the active `plan.json` actually has independent phases to schedule
(explicit `depends_on`, or two phases that both depend only on the same prior
phase via the implicit previous-entry chain). A plan with no independent phases
just runs waves of size 1 forever — safe, but it proves nothing.

- Observable *before* enabling: the plan validates with **zero DAG problems**
  (`validatePlanStructure`) — a plan with cycle/unknown-ref problems silently
  degrades to serial (fail-safe), so a "successful" run at this step doesn't tell
  you the DAG is actually being used unless the plan is clean.
- Observable *after* enabling: watch `phase_lanes` rows during a run (`running` →
  `done`/`abandoned`) and watch **window density** — a 2-lane wave roughly doubles
  the in-flight `claude -p` calls for that stretch of the run. This rides on brief
  05's fair-share window scheduling and `billing-guard`'s `windowStatus` as the
  guard rail; **this cycle adds no new budget math**. Confirm at least one clean
  2-lane wave merges strictly ascending with exactly **one** push before trusting
  it on a larger plan.

### Step 4 — `bug_cycle.max_parallel_fixes: 2`

**Prereq:** step 3 has soaked. Fix lanes reuse the exact same `lane-manager.js`
machinery as phase waves, so a phase-wave run you already trust materially de-risks
this step.

- Observable: same shape as step 3 — `phase_lanes` rows for `fix-r<R>-<N>` lanes,
  `fixes_completed` staying **contiguous** even across a failed-middle-lane
  permutation, exactly one push per batch.
- Note: mutually exclusive with step 2 in v1 — see Precedence, below. Turning this
  on effectively supersedes `batch_minor_fixes` for that project (lanes win); you
  can leave `batch_minor_fixes: true` set (it just goes dormant) or turn it back off.

### Step 5 — `auto_run.speculative_duo_on_double_failure: true`

**Prereq:** steps 2–4 have soaked, **and** only enable this for a project that
actually has `force_tier`-critical phases — i.e. `config/model-routing.json`
keyword rules (regulatory-core/security-core) can select one of its phases. For any
other project the eligibility gate never fires; the flag is safe but permanently
dormant there.

- Observable *before* enabling: confirm `windowStatus` genuinely has headroom for 4
  calls (2 dev legs + 2 judges) below `warn_at_calls` under the project's normal
  call volume — the duo self-gates on this, so if headroom is rarely available the
  duo will rarely actually fire (it just pauses as today instead).
- Observable *after* enabling: on the (rare) double-failure of a force_tier phase,
  check `.guide/phases/<n>-*/duo.json` for the outcome (`merged` / `both-fail` /
  `aborted`) and confirm both lane worktrees + branches are gone afterward. A
  refused leg (fable declining security/regulatory content) shows up in `duo.json`
  as a **lost leg**, never as an auto-heal or escalation-ladder event.

Once `npm run verify:parallel` is green on your machine (it exercises all four
features end-to-end against fixture repos with zero LLM spawns) and step 2 has
soaked on a real project, steps 3–5 are safe to schedule — each is strictly
additive risk on top of the lane-manager primitive steps 3/4 share.

## Failure semantics — one shape for all four features

Every feature degrades to the **existing** serial/escalation/park ladder on
failure. Nothing in this cycle invents a new failure path.

- **The prefix rule.** Phase waves and fix lanes both walk their settled lanes in
  ascending order and merge only the **contiguous successful prefix**. The first
  failed or conflicted lane stops the walk; everything after it — even a lane that
  itself succeeded — is **abandoned** (torn down, a `lane-abandoned` lesson
  recorded) so the merge is never applied out of order. The failed unit re-runs
  through the ordinary reprompt/escalate/pause (phases) or park (fixes) ladder on
  its next pick; abandoned units simply re-wave/re-batch once the one ahead of them
  resolves.
- **Conflict fallback.** A merge conflict — two lanes touched the same file despite
  passing the in-code `files_expected`/`files_likely` disjointness check — is
  handled exactly like a failed lane under the prefix rule: `git merge --abort`,
  the lane branch discarded, a `lane-conflict` lesson recorded, normal serial
  re-run next. Disjointness is a defensive *estimate*, never authoritative; the
  merge-time conflict is the real backstop when the estimate is wrong.
- **Counter contiguity.** The `bug_rounds` table's `fixes_completed` column is a
  bare incrementing counter used as an array index. Fix lanes and single-call
  batching only ever call `recordFixCompletion` for the contiguous committed
  prefix, in ascending order, and only **after** the merged-HEAD validator gate has
  passed. This keeps `fixes_completed` equal to the count of fixes actually
  committed under every failure permutation.
- **Batch reset-to-`preBatchSha`.** Single-call batching runs in the real
  workspace, so a failure can't just be "abandoned" like a lane — `preBatchSha` is
  captured before the spawn, and on a call error or a failed merged-HEAD gate the
  batch's commits are rolled back via `git reset --hard preBatchSha`, but **only**
  when `aheadBehind` confirms they're still unpushed (`ahead > 0 && behind === 0`);
  anything ambiguous or already pushed is left alone and falls through to the
  ordinary single-fix failure path instead of being reset. No batch-level
  escalation/validation marker is written; every fix in the batch re-dispatches
  **individually** on the next pick (a `batchFallbackFixes` set forces this — never
  re-batched).
- **The merged-HEAD gate is mandatory, always.** Whether or not a lane ran its own
  in-lane validator gate, there is always exactly **one** additional validator gate
  on the merged HEAD before anything is pushed. A red merged HEAD is rolled back to
  the pre-wave/pre-batch base and never reaches origin.

## The `node_modules` symlink caveat

`parallel_lanes.node_modules` defaults to `"symlink"`: a new lane's `node_modules`
is a **symlink into the primary workspace's `node_modules`**, not a fresh copy or a
fresh `npm install`. This is deliberately cheap — installing fresh per lane would
multiply run time and disk for every wave/batch/duo — but it means **the store is
shared, not isolated**: if a lane's dev/fix prompt runs `npm install` (adding,
removing, or updating a dependency) inside that lane, it mutates the **same**
`node_modules` that every other concurrently-running lane, and the primary
workspace, are reading from at that exact moment.

A lane that genuinely needs to install its own dependencies should run with
`parallel_lanes.node_modules: "none"` instead — that lane gets no `node_modules` at
all, its in-lane validator gate is disabled (`gateInLane: false`), and only the
mandatory merged-HEAD gate (real `node_modules`, in the primary workspace, run
after the merge) ever validates it. `"none"` is also the automatic fallback
whenever the primary workspace itself has no `node_modules` to symlink from.

## Precedence when features overlap

`bug_cycle.batch_minor_fixes` (step 2) and `bug_cycle.max_parallel_fixes > 1`
(step 4) are **mutually exclusive in v1**: single-call batching is only ever
consulted when `max_parallel_fixes === 1`. If both are enabled on a project,
**lanes win** — batching is skipped outright, with a dim log line naming the
deciding config key, even if that pick's lane-batch selection would itself have
collapsed to a single fix. There is no combined "batch within a lane" mode yet.
