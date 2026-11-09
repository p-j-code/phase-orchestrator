# New Features — v0.7 through v0.14

Everything shipped after the v0.6 handoff. One stop. Skim the table of contents, jump to what you need.

- [Cleanup](#cleanup)
- [Project context](#project-context)
- [Routing extensions](#routing-extensions)
- [Requirements inbox](#requirements-inbox)
- [Wake lock + live spinner](#wake-lock--live-spinner)
- [Validators](#validators)
- [Cost prediction](#cost-prediction)
- [Triage TUI](#triage-tui)
- [Auto-run summary + cumulative time](#auto-run-summary--cumulative-time)
- [QA handoff](#qa-handoff)
- [Multi-row LiveStatus spinner (v0.14.9)](#multi-row-livestatus-spinner-v0149)
- [Transient-error retry classification (v0.14.10)](#transient-error-retry-classification-v01410)
- [`/req_promote` fast lane (v0.14.11)](#req_promote-fast-lane-v01411)
- [`_inbox` refine FK fix (v0.14.12)](#_inbox-refine-fk-fix-v01412)

---

## Cleanup

**What:** Automatic pruning of `logs/*.log`, dashboard files in `outputs/`, and stale rows in the SQLite `calls` table. Runs at server boot and every 6 hours while the server is alive. No manual cron needed.

### Commands

```bash
npm run cleanup                              # run once now
npm run cleanup -- --dry-run                 # show what would be deleted
npm run cleanup -- --dry-run --verbose       # also print stats when no-op
```

### Configuration

In `config/defaults.json`:

```json
"cleanup": {
  "enabled": true,
  "logs_retention_days": 30,
  "logs_max_files": 5000,
  "outputs_retention_days": 14,
  "calls_retention_days": 90,
  "min_age_minutes": 60,
  "run_on_server_start": true,
  "run_interval_hours": 6
}
```

Override per-project in `projects/&lt;name&gt;/project.json` → `overrides.cleanup`. Disable per-host with `cleanup.enabled: false` in `~/.ashmero-orchestrator/user.json`.

### Safety contract

- Only touches `logs/*.log`, `outputs/dashboard-*.html`, and old `calls` rows
- Never touches `.guide/`, `workspace/`, `state/orchestrator.db` (besides the calls table), or project zips in `outputs/`
- Skips files newer than `min_age_minutes` so any in-flight subprocess writing to its log is never affected

### Output

```
[cleanup] logs=423 (1.8MB) outputs=12 (340KB) calls=1847
```

---

## Project context

**What:** Per-project markdown file at `.guide/project-context.md` that gets injected as a system-prompt prefix on every guide and dev call for that project. Tells the agent the domain, audience, regulatory regime, UX conventions, and project-specific prompting rules.

### Commands

```bash
# Generate one (Sonnet call, ~$0.05) — reads brief + workspace + raw-thoughts
npm run context -- <project>
npm run context -- <project> --force         # overwrite existing
```

### File structure (template)

```markdown
# Project Context — <project-name>

## Domain
What this software is, in 2-3 sentences. End with "Non-goals: ..."

## Audience
- Primary user: who, business size, role
- Team size and roles
- Device priority, tech sophistication

## Geographic & Regulatory
- Country / region / currency / timezone / date format conventions
- Named regimes (GST, TDS, DPDP, HIPAA, etc.)
- Specific schemas to conform to

## UX & Cultural Conventions
- Language(s), code-mixing rules
- Currency display format
- Payment rail priority
- Tone register

## Prompting Guidance
- "When X, do Y" rules (5-10) informed by workspace + brief
```

### How it's used

Loaded by `src/lib/phase-runner.js` before every guide and dev call, wrapped in `&lt;project_context&gt;...</project_context>` tags, and appended to the system prompt via `--append-system-prompt`. No change to existing prompts — additive.

The BillFlow `.guide/project-context.md` pre-shipped with v0.7 has 10 prompting rules covering multi-tenancy, ObjectId casting, audit logging, tax computation, FVU generation, PAN handling, UI copy, invoice numbering races, webhook signature parsing, and regex escaping. Edit to taste.

---

## Routing extensions

**What:** Per-project `routing-extension.json` merged into the global keyword rules in `config/model-routing.json`. Lets you bias routing toward Opus for project-specific risk areas (tax, security, payments) without polluting the global config.

### File location

`projects/&lt;name&gt;/routing-extension.json`

### Format

```json
{
  "keyword_rules": [
    {
      "label": "billflow-tax-core",
      "patterns": ["\\bGSTR-1\\b", "\\bForm 26Q\\b", "\\bFVU\\b"],
      "force_tier": "opus",
      "rationale": "Regulatory filing artifacts — wrong defaults = compliance failure"
    },
    {
      "label": "billflow-multitenant-security",
      "patterns": ["businessId", "cross-tenant", "requireBusiness"],
      "min_tier": "sonnet",
      "rationale": "Multi-tenant isolation"
    }
  ]
}
```

`force_tier` is a ceiling override (always at least this tier). `min_tier` is a floor (could go higher via complexity).

### Inspect routing for a project

```bash
npm run analyze -- <project>
# Shows the routing table including merged extension rules.
```

---

## Requirements inbox

**What:** Persistent backlog of raw thoughts captured in your own words. Triage when ready. Promote selected items into a project's `raw-thoughts.md` for the existing brief flow.

### CLI commands

```bash
# Capture
npm run req -- <project> add "the dashboard needs monthly revenue breakdown"
npm run req -- _inbox add "GSTR-2A reconciliation flow"     # virtual project for unscoped capture
echo "..." | npm run req -- billflow-tds add -              # read from stdin

# List
npm run req -- <project> list                                # default: status=inbox
npm run req -- <project> list --all
npm run req -- <project> list --status refined --priority p1
npm run req -- <project> show <id>

# Triage one at a time (interactive)
npm run req -- <project> triage <id>
npm run req -- <project> set <id> priority p2
npm run req -- <project> set <id> scope now
npm run req -- <project> drop <id>

# Fast triage (recommended, see Triage TUI section)
npm run triage -- <project>

# Refine (Sonnet batched call over all inbox items)
npm run req -- <project> refine

# Promote to brief
npm run req -- <project> promote --scope now      # appends to raw-thoughts.md
npm run brief -- <project>                         # then run the existing brief flow

# Stats
npm run req -- <project> stats
npm run req -- projects                            # which projects have requirements
```

### Telegram

```
/req billflow-tds <text>          one-shot capture into project
/req <text>                       one-shot capture into _inbox
/capture billflow-tds             enter multi-message capture mode
/done                             exit capture mode
/inbox                            list projects with requirements
/inbox billflow-tds               browse + tap-to-triage
```

### States

- `inbox` — raw, just captured
- `refined` — AI has produced structured title/what/why/touches/open-questions
- `promoted` — appended to a project's `raw-thoughts.md`, won't re-appear
- `dropped` — soft-deleted

### Priority + scope

- `priority` ∈ `p0 | p1 | p2 | p3 | unassigned`
- `scope` ∈ `now | next | later | no | unassigned`

Scope is the actionable axis — `promote --scope now` collects scope=now items into the next brief.

### Storage

SQLite table `requirements` in `state/orchestrator.db`. Survives reboots. Applied via `npm run migrate-requirements`.

---

## Wake lock + live spinner

**What:**
- **Wake lock:** macOS-only. Refcounted `caffeinate -i -s` keeps the system awake during long-running operations. Active during any in-flight claude call AND for the entire span of `npm run go` / `npm run server`. No-op on Linux (TARA / NAS).
- **Live spinner (single-call):** `npm run go` and other one-shot CLI commands show a per-call elapsed-time spinner. `⠴ phase-prompt-gen running… [0:42]` → `✓ phase-prompt-gen done in 1m 23s`. Degrades gracefully in non-TTY environments to plain start/finish lines.
- **Live multi-row spinner (server mode, v0.14.9+):** When `npm run server` is running and two or more workers are processing jobs concurrently, the spinner area becomes an anchored multi-row "live region" at the bottom of stdout. One row per active worker, each tagged `[wN project]`. `console.log` lines (git pushes, validator output, etc.) scroll above the live region without garbling it.

```
[w1 billflow-tds] ▶ Picking up job #371: dev billflow-tds
[w1 billflow-tds] ✓ Pushed develop → origin (c1932833)
[w2 reelchain]    ▶ Picking up job #84: review reelchain
─────────────────────────────────────────────────────────
⠋ [w1 billflow-tds] fix-execution running…   [5m 28s]
⠋ [w2 reelchain]    3-phase-review running…  [6m 11s]
```

Replaces the v0.8 single-spinner that broke under cross-project concurrency (two `ora` instances clobbering each other's terminal line, leaving ghosted rows and garbled lines with `git push` output appended). See `src/lib/live-status.js`.

### Configuration

In `config/defaults.json`:

```json
"wake_lock": {
  "enabled": true
}
```

Set `false` to manage `caffeinate` yourself.

### Per-run override

```bash
ORCHESTRATOR_NO_SPINNER=1 npm run go -- <project>   # suppress spinner without disabling wake lock
```

### Limit worth knowing

`caffeinate -i -s` doesn't override clamshell-on-battery. macOS will still sleep if you close the lid on battery power. On AC with lid closed, system stays awake. This is a macOS hard limit.

---

## Validators

**What:** External validator scripts that run automatically after every dev/fix execution. Configured per-project via `validators.json`. Any failure pauses the auto-runner with a clear reason.

> **Reference templates ship at `examples/validators/`** (v0.14.6+). The
> `examples/validators/billflow-tds/` set is a known-good starting point for
> a GST/TDS-style project — copy it into your own project tree with
> `cp -r examples/validators/billflow-tds/* projects/&lt;your-project&gt;/`,
> then edit. The originals previously lived under `projects/billflow-tds/`,
> which made every release zip's `unzip -o` silently overwrite operator
> edits (BUG-2); moved to `examples/` so reference and live trees are
> properly separated.

### Per-project setup

`projects/&lt;name&gt;/validators.json`:

```json
{
  "validators": {
    "smoke":   { "script": "validators/smoke.sh",   "timeout_ms": 30000 },
    "tests":   { "script": "validators/tests.sh",   "timeout_ms": 180000 },
    "nsdl-fvu": { "script": "validators/nsdl-fvu.sh", "timeout_ms": 120000 }
  },
  "rules": [
    { "match": { "always": true },                         "run": ["smoke"] },
    { "match": { "phase_title_regex": "test|payment" },    "run": ["tests"] },
    { "match": { "fix_title_regex": "FVU|NSDL" },          "run": ["nsdl-fvu"] }
  ]
}
```

Match criteria: `always`, `phase`, `phase_title_regex`, `fix_round`, `fix_n`, `fix_title_regex`.

### Validator script contract

- Runs from `projects/&lt;name&gt;/` cwd
- Env vars: `ORCHESTRATOR_PROJECT`, `ORCHESTRATOR_PROJECT_DIR`, `ORCHESTRATOR_WORKSPACE_DIR`, plus `ORCHESTRATOR_PHASE` or `ORCHESTRATOR_FIX_ROUND`/`ORCHESTRATOR_FIX_N`
- Exit 0 = pass (auto-run continues); non-zero = fail (auto-run pauses)
- Stdout / stderr captured; tail of stderr shown inline on failure; full output to `logs/validator-*.{stdout,stderr}.log`

### Commands

```bash
npm run validate -- <project> --all                # run rules matching {always:true}
npm run validate -- <project> --phase 5            # as if phase 5 just completed
npm run validate -- <project> --fix 4.2            # as if fix r4.2 completed
npm run validators -- <project>                    # show recent runs
npm run validators -- <project> --limit 50
```

### Failure flow

When auto-runner hits a validator failure:

```
▸ Running 2 validator(s) for fix r4.5…
✓ smoke pass (0.4s)
✗ nsdl-fvu FAIL (exit 1, 12.3s)
  [nsdl-fvu] Validation error: SECTION_MAP deducteeType inverted at row 47

⏸  Paused: validators failed: nsdl-fvu
```

Resume with `npm run resume -- &lt;project&gt;` after fixing.

### Configuration

Global in `config/defaults.json`:

```json
"validators": {
  "enabled": true,
  "default_timeout_ms": 60000
}
```

Set `enabled: false` to skip validators globally. Per-project override in `project.json` → `overrides.validators`.

### Migration

`npm run migrate-validators` — adds `validator_runs` table.

### BillFlow's shipped validators

- `smoke.sh` — workspace integrity, package.json parses, last-commit JS files syntax-check
- `tests.sh` — runs `npm test` in `workspace/backend`
- `nsdl-fvu.sh` — validates FVU files against NSDL JAR (requires `NSDL_FVU_JAR` env var or JAR at `~/Downloads/nsdl-fvu.jar`)
- `gstr-1-schema.js` — validates GSTR-1 JSON for the round-3 BUG-8 findings (gstin format, fp MMYYYY, b2cs aggregation, idt date format)

---

## Cost prediction

**What:** Predicts the cost of upcoming work (phases or current bug round's fixes) before kicking off. Walks each unit through the routing engine (no API call) and multiplies by historical averages from the `calls` table.

### Commands

```bash
npm run predict -- <project>                       # standalone
npm run predict -- <project> --compact             # summary only
```

### Integrated into `go` / `resume`

`npm run go -- &lt;project&gt;` runs prediction first and shows:

```
Predicted: bug round 4 (20 fixes)

  Unit                  Task                  Model                   Cost      Time
  ────────────────────────────────────────────────────────────────────────────────
  fix r4.1 (race…)      fix-prompt-gen        claude-sonnet-4-6       $0.03     20s
  fix r4.1 (race…)      fix-execution         claude-opus-4-7         $0.18     2m 15s
  ...
  ────────────────────────────────────────────────────────────────────────────────
  TOTAL                 40 calls                                      $4.85     ~28m

Budget impact:
  Window calls before:   12
  Project cap:           100
  After this run:        52/100 (52%)

Proceed? [y/N]
```

Prompts when predicted cost ≥ $1 or budget would be exceeded. Otherwise auto-proceeds.

### Skip prediction

```bash
npm run go -- <project> --no-predict               # skip entirely
npm run go -- <project> --yes                      # show but auto-confirm
npm run go -- <project> --unattended               # same as --yes
```

### How averages are computed

For each `(model, task)` combo, the predictor queries the `calls` table for `avg(cost_usd)`, `avg(duration_ms)`. If no data for that combo, falls back to tier-level avg for the model. If no data at all, uses hardcoded defaults: opus $0.18, sonnet $0.04, haiku $0.005. Fallback values are marked with `~` in the output.

Accuracy improves as call history grows.

---

## Triage TUI

**What:** Fast keypress-driven triage for the requirements inbox. One item shown at a time, single-key actions, auto-advance on scope set.

### Start

```bash
npm run triage -- <project>
npm run triage -- <project> --refined              # only AI-refined items
```

### Keys

| Key | Action |
|-----|--------|
| `0` `1` `2` `3` | Set priority p0/p1/p2/p3 (does NOT advance) |
| `n` `x` `l` | Set scope now/next/later (advances) |
| `!` | Set scope=no (advances) |
| `s` | Skip without saving (advances) |
| `d` | Drop (status='dropped', advances) |
| `a` | AI-suggest priority+scope (one Sonnet call) |
| `Enter` | Accept pending AI suggestion |
| `?` | Show help |
| `q` / `Ctrl-C` | Quit |

### AI suggest

Press `a` on any item. One Sonnet call with the item + project-context.md + last 5 triaged items as calibration reference. Returns `{priority, scope, rationale}`. Press Enter to accept, any other key to override.

### Session summary

On exit:

```
Triage summary
  Items reviewed:       12
  Priority set/changed:  9
  Scope set/changed:    11
  Dropped:               1
  Skipped:               0
  AI suggestions:        3
```

### Telegram

```
/triage <project>
```

Inline keyboard with all priority + scope buttons per item. Tap scope to auto-advance (1 tap typical). Tap priority first then scope (2 taps) for full triage. `[skip]`, `[drop]`, `[done]` for non-default flows. Stateless via callback data.

---

## Auto-run summary + cumulative time

**What:**
- Every action header shows cumulative run time alongside per-call elapsed
- Summary block on completion, pause, failure, or Ctrl-C cancel — start time, end time, wall time, call counts, cost, tokens

### What you see during a run

```
▶ Execute fix: round 4 fix 14 (...)     [run: 23m 17s]
   Task: fix-execution
   ...
⠼ fix-execution running…  [1:42]
```

Two timers visible: cumulative (`[run: 23m 17s]`) and per-call (`[1:42]`).

### Summary on completion

```
────────────────────────────────────────────────────────
  ✓ COMPLETED — billflow-tds
────────────────────────────────────────────────────────
  Started:        2026-05-24 08:07:13
  Ended:          2026-05-24 08:54:31
  Wall time:      47m 18s
  Reason:         all work complete

  Calls in this run: 14
    fix-execution            6
    fix-prompt-gen           6
    3-phase-review           2

  Cost (Max-equiv): $3.42
  Tokens:           in 487K  out 71K
  Time in calls:    38m 45s  (of 47m 18s wall — rest is guide/dev I/O + thinking)
────────────────────────────────────────────────────────
```

### Cancellation

Ctrl-C during a run marks it `cancelled`, prints the summary, exits cleanly. Second Ctrl-C force-quits. Reason: `user cancelled (SIGINT)`.

### Pause / fail variants

`⏸ PAUSED` (validator failure, budget, checkpoint), `✗ FAILED` (exception). Same layout, status banner changes.

---

## QA handoff

**What:** Tester-friendly markdown checklist generated from a bug round or phase range. Combines `bugs.md`, fix reports, validator runs, git history, and (optionally) LLM-generated manual test procedures.

### Commands

```bash
# Extractive — free, instant
npm run qa-handoff -- <project>                     # most recent bug round
npm run qa-handoff -- <project> --round 4           # specific round
npm run qa-handoff -- <project> --phases 1:8        # phase range for feature work

# LLM-augmented — one Opus call (~$1-2), adds plain-tester manual test procedures
npm run qa-handoff -- <project> --round 4 --with-steps

# Override output path
npm run qa-handoff -- <project> --round 4 --output /tmp/qa.md
```

### Output

Lands at `projects/&lt;name&gt;/.guide/qa-handoffs/qa-handoff-&lt;scope&gt;-&lt;timestamp&gt;.md`.

Structure:
- Tester-info template (name, date, branch, build SHA)
- Quick stats (bug counts by severity, validators pass/fail, cost, commits)
- Per bug, sorted by severity:
  - Auto-checks status (validator results)
  - What was happening / expected / acceptance (from bugs.md)
  - Excerpt from the dev agent's fix report
  - Auto-derived "Verify" checkboxes (heuristic from acceptance)
  - With `--with-steps`: manual setup + numbered steps + verify items + regressions to check
- Validator failures section — items that failed but shipped
- Git commits in scope
- Sign-off section

### When `--with-steps` is worth it

- Use it when you're handing the doc to QA who don't know the code
- Skip it when you're verifying yourself or handing to engineers
- It's a single batched Opus call, so cost scales linearly with bug count (~$0.05-$0.15 per bug)

---

## Quick reference card

```bash
# Cleanup (auto, but ad-hoc available)
npm run cleanup [-- --dry-run --verbose]

# Project context
npm run context -- <project>

# Requirements inbox
npm run req -- <project> add "..."          # capture
npm run req -- <project> refine             # AI clean
npm run req -- <project> promote --scope now
npm run triage -- <project>                 # fast keypress triage

# Cost prediction
npm run predict -- <project>
npm run go -- <project>                     # prediction integrated

# Validators
npm run validate -- <project> --all
npm run validators -- <project>             # history

# QA handoff
npm run qa-handoff -- <project> --round 4 [--with-steps]

# Telegram (server must be running)
/req /capture /done /inbox /triage
```

## Configuration files at a glance

| File | What it controls |
|------|------------------|
| `config/defaults.json` | Global defaults — cleanup, wake_lock, validators, billing, routing, auto-run, phases, review |
| `config/model-routing.json` | Global routing rules (keywords + complexity thresholds) |
| `config/profiles/*.json` | Reusable presets bundled by tech stack |
| `~/.ashmero-orchestrator/user.json` | User-level overrides (per-host) |
| `projects/&lt;name&gt;/project.json` | Project-level overrides via `overrides.X` |
| `projects/&lt;name&gt;/routing-extension.json` | Project-specific keyword rules |
| `projects/&lt;name&gt;/validators.json` | Project-specific validators + rules |
| `projects/&lt;name&gt;/.guide/project-context.md` | Domain/audience/regulatory injected on every call |

## Migrations cheat sheet

```bash
npm run migrate                         # base v0.2+ schema (projects/phases/sessions/calls/auto_runs/bug_rounds)
npm run migrate-bot                     # v0.5 — tg_users, tg_jobs
npm run migrate-requirements            # v0.7 — requirements, tg_capture_modes
npm run migrate-validators              # v0.9 — validator_runs
```

All migrations are additive and idempotent. Safe to re-run.

---

# Part 2 — v0.12 through v0.14

This section covers everything shipped after the v0.11 line: the bug inbox,
git management, and per-project queues with cross-project concurrency.

- [Bug inbox (v0.12)](#bug-inbox-v012)
- [Git management (v0.13)](#git-management-v013)
- [Per-project queues + cross-project concurrency (v0.14)](#per-project-queues--cross-project-concurrency-v014)
- [Telegram command reference](#telegram-command-reference)

---

## Bug inbox (v0.12)

A parallel surface to the requirements inbox, but for bugs. Capture from
Telegram or CLI, severity-rank, batch-promote into a fix round.

### Table

`bug_inbox` — added in v0.12.0 via `npm run migrate-bug-inbox` (auto-applied
when `state.js`'s `migrate()` runs).

### CLI

```bash
npm run bug -- <project> add "<text>"          # capture
npm run bug -- <project> list                  # show inbox
npm run bug -- <project> show <id>             # detail one bug
npm run bug -- <project> set <id> --severity CRITICAL
npm run bug -- <project> drop <id>             # delete
npm run bug -- <project> refine <id>           # Opus rewrites the bug text
npm run bug -- <project> promote --ids 1,3,5   # → bugs-round-N
npm run bug -- <project> promote --severity CRITICAL --run
npm run bug -- <project> stats
```

### Telegram

- `/bug [project] &lt;text&gt;` — quick-capture
- `/bug_capture [project]` — multi-message capture mode; everything you
  type is captured until `/bug_done`
- `/bug_done` — exit capture mode
- `/bugs_inbox [project]` — list bugs
- `/bug_promote [project] [--ids ...] [--severity ...]` — promote → round-N
  → enqueue `go` job. Works entirely from phone since v0.12.4. Bot replies
  with the job ID; progress notifications follow as fixes land.

Aliases (Telegram commands can't contain hyphens): `/bugcapture`,
`/bugdone`, `/bugsinbox`, `/buginbox`, `/bugpromote`.

### Critical-bug fast path

When you capture a bug and tag it CRITICAL, the bot offers inline buttons:
`🚨 Run now` / `📋 Queue` / `Just save`. Tapping "Run now" promotes + queues
a `go` action in one step.

---

## Git management (v0.13)

Before v0.13, the orchestrator told the dev agent to commit but did nothing
about pushing — pushes were either improvised by the agent or done by you
on Mac. Hard to coordinate when the orchestrator runs on NAS and you
review on Mac. v0.13 makes the orchestrator the authoritative pusher and
puller for each project.

### What runs around every dev invocation

**Before** the dev agent is spawned:

1. Verifies workspace is a git repo, has `origin`, is on the configured
   branch (`project.git_branch`, default `develop`)
2. `git fetch origin &lt;branch&gt;`
3. Decides based on ahead/behind:
   - In sync → proceed
   - Behind → `git pull --ff-only`, proceed (this is the "Mac pushed,
     NAS needs to pull before running" case — the original gap)
   - Ahead-only → proceed (next push catches up)
   - **Diverged** (both ahead and behind) → halt with reconciliation
     recipe. Never auto-rebases.

**After** the dev agent completes:

1. `git rev-parse HEAD` to capture the commit SHA
2. Stores it in `phases.commit_sha` (this also unblocked `retry-phase`,
   which had been silently broken pre-v0.13 because the SHA was never
   recorded)
3. `git push --set-upstream origin &lt;branch&gt;` (no `--force`)
4. Push failure → yellow warning + `git_result.error` on return. Does
   NOT fail the phase. Surfaced in stdout for systemd journal capture.

### Per-project git config

Two new columns on the `projects` table (auto-added on first DB open via
`state.js`'s `addCol()` helper, idempotent):

| Column | Purpose |
|---|---|
| `git_branch` | The orchestrator's working branch. Pre-flight refuses to dispatch dev if workspace isn't on this branch. NULL = git management disabled. |
| `git_remote` | Origin URL (for visibility — actual push uses the workspace's git remote). |

Also mirrored into `project.json` as `git_branch` and `git_remote`.

### Commands

| Command | What it does |
|---|---|
| `npm run migrate-git -- --project &lt;name&gt;` | Bring an existing project under management. Creates `develop` from current HEAD if missing, pushes, records in SQLite. Idempotent. Flags: `--branch &lt;name&gt;`, `--remote &lt;url&gt;`, `--init`. |
| `npm run sync -- &lt;name&gt;` | Manual fetch + ff-only pull on configured branch. Same logic the pre-flight runs. |
| `npm run ship -- &lt;name&gt; [--tag vX.Y.Z]` | Fast-forward `main` to `develop`, push, optional tag. Refuses on diverged/dirty/non-FF. Syncs develop with origin first (v0.14). |
| `npm run git-status -- &lt;name&gt;` | Branch, remote, working-tree clean/dirty, ahead/behind vs origin, ship-lag. |
| `npm run new -- &lt;name&gt; --git-remote &lt;url&gt;` | One-shot import or greenfield. Probes the remote — clones if it has commits, inits + pushes if empty (v0.13.3). |

### Telegram

| Command | Purpose |
|---|---|
| `/git_status [project]` | Same as CLI, formatted for chat. |
| `/sync [project]` | Manual pull. Halts on divergence with reconciliation recipe. |
| `/ship [project] [--tag vX.Y.Z]` | Promote develop → main. |
| `/new_project &lt;name&gt; &lt;git-url&gt;` | Import a project from a git URL. Name optional (inferred from URL). Inline execution; typical clone <30s. |

Aliases: `/git`, `/gitstatus`, `/gitpull`, `/pull`, `/shipproject`,
`/newproject`, `/import`, `/addproject`.

### The hazard to remember

The orchestrator owning pushes means **never push from Mac to a branch
the orchestrator is managing**. If Mac and NAS both push, the second push
fails with non-fast-forward. Rule: **NAS pushes, Mac pulls.** The
pull-before-dispatch handles the case where Mac pushes between two
orchestrator runs.

### Audit-to-bugs regex tolerance (v0.13.2)

When Opus writes the audit's "Promote to bugs-round-N" section, it
sometimes code-formats the round name: `## Promote to \`bugs-round-7\``.
The extractor regex now tolerates backticks, asterisks, and underscores
around the identifier, and multi-digit round numbers.

### Preview message-too-long fix (v0.13.1)

`/preview` used to crash with 400 "message is too long" on audits with
big code-fenced sections. The splitter no longer special-cases code
blocks (Telegram `&lt;pre&gt;` is opaque to markdown anyway), the chunk size
ceiling dropped to 3200 chars (headroom for HTML entity expansion), and
each `ctx.reply()` is wrapped in defensive try/catch that bisects and
retries on 400 errors. The bot stays online even on edge cases.

### Project.json schema (v0.14.1)

`profile`, `tech_stack`, `git_branch`, `git_remote` accept null in
addition to string. `guide_layout_version`, `git_branch`, `git_remote`
are now documented in the schema. Status enum includes `ready-for-qa`
and `cancelled` (which the orchestrator already set in code but the
schema rejected). `create-project.js` no longer emits keys with null
values for optional fields, so generated `project.json` files validate
cleanly out of the box.

---

## Per-project queues + cross-project concurrency (v0.14)

The single job-processor loop is replaced with an N-worker pool. Same
SQLite table, smarter SELECT.

### Behavior

- **Within a project**: strict FIFO. Two jobs on `billflow-tds` never run
  concurrently — second waits for first.
- **Across projects**: concurrent up to `max_concurrent_projects`.
  Triggering `audit reelchain` while `go billflow-tds` is mid-run starts
  the audit on a second worker immediately.

### The picker SQL

```sql
SELECT * FROM tg_jobs AS j
WHERE j.status = 'pending'
  AND j.project NOT IN (SELECT project FROM tg_jobs WHERE status = 'running')
  AND NOT EXISTS (
    SELECT 1 FROM tg_jobs AS earlier
    WHERE earlier.project = j.project
      AND earlier.status = 'pending'
      AND earlier.id < j.id
  )
ORDER BY j.id ASC LIMIT 1
```

In English: "oldest pending job whose project isn't already running, and
for which no older pending job exists on that same project." That's
per-project FIFO without literally having separate queues.

Worker safety: an in-process mutex serializes picker calls (they're
async coroutines in one event loop), and `tryClaimJob(id)` does an
atomic `UPDATE … WHERE id=? AND status='pending'` as the authoritative
gate. Effective race window: microseconds.

### Config

`config/defaults.json`:

```json
"job_runner": {
  "max_concurrent_projects": "auto",
  "max_workers_cap": 8
}
```

Default is `'auto'` — counts projects in SQLite at server start, spawns
that many workers, clamped to `[1, max_workers_cap]`. Set to a positive
integer to override. Auto-scaling is a startup-only decision; if you
create a new project mid-session via `/new_project`, the worker count
doesn't grow until you restart the server.

Tune per host. Mac with 80%+ rate-limit headroom: 3–4 reasonable.
A low-power NAS CPU: probably 1–2 (CPU-bound on JS-heavy phases). Higher values
burn the Claude Max budget faster, so the practical ceiling is when
`billing-guard` starts pausing you before the 5-hour window closes.

### Display changes

- **`/status`** lists all running jobs (was: one), groups pending queue
  by project.
- Console output prefixes each line with `[w1]` / `[w2]` etc. so you can
  untangle interleaved workers in the systemd journal.
- Graceful SIGINT waits for every worker to finish its current job.

### To restore old behavior

```json
"job_runner": { "max_concurrent_projects": 1 }
```

Reverts to strictly sequential, one global FIFO.

---

## Telegram command reference

| Category | Commands |
|---|---|
| Onboarding | `/start`, `/auth` |
| Navigation | `/projects`, `/project`, `/pin`, `/unpin`, `/pinned` |
| Running | `/run`, `/queue`, `/cancel`, `/dequeue` |
| Monitoring | `/status`, `/history` |
| Artifacts | `/files`, `/preview`, `/file`, `/download` |
| Requirements | `/req`, `/capture`, `/inbox`, `/triage`, `/done` |
| Bug inbox | `/bug`, `/bug_capture`, `/bug_done`, `/bugs_inbox`, `/bug_promote` |
| Git (v0.13+) | `/git_status`, `/sync`, `/ship`, `/new_project` |
| Help / admin | `/help`, `/docs`, `/users` |

Most project-taking commands accept `[project]` as optional — they use
your pinned project (`/pin`) if you leave it off.

Patterned artifact shortcuts for `/preview` and `/file`: `brief`, `plan`,
`raw-thoughts`, `context`, `audit`, `roadmap`, `qa`, `audit:&lt;ts&gt;`,
`phase:N`, `plan:N`, `bugs:N`, `fix:R:N`, `review:N`, `qa:N`.

For the full BotFather `/setcommands` payload, see `src/lib/command-menu.js`
(v0.14.15+). The orchestrator registers the menu automatically at every
server boot — you don't need to copy-paste anything into BotFather. Run
`/help` from the bot for the in-chat command list, or check
`docs/TELEGRAM_BOT.md` for the full reference.

---

## Multi-row LiveStatus spinner (v0.14.9)

**What:** Replaces the per-call `ora` spinner with a shared multi-row "live region" anchored at the bottom of stdout. One row per active worker, each tagged `[wN project]`. Patches `process.stdout.write` and `process.stderr.write` once at server boot so any foreign write (console.log, git push output, anything) clears the live region, lands in scrollback, then re-renders the live region underneath.

**Why it was needed:** With the v0.14.0 worker pool running concurrent jobs across projects, two `ora` instances would fight over the same TTY — `ora` is designed for one active spinner per terminal. Symptom: ghosted "running…" rows that never updated, and lines like `∷ fix-execution running…  [5m 01s]✓ Pushed develop → origin (c1932833)` where a `git push` console.log landed on top of a spinner row.

**Where:**
- `src/lib/live-status.js` — the manager. ANSI-aware width clipping, SIGWINCH re-render, cursor hide/show, graceful no-op in non-TTY.
- `src/lib/worker-context.js` — hosts the per-worker `AsyncLocalStorage`, hoisted out of `src/server.js` so `claude-runner.js` and `validators.js` can read `{workerId, project}` for the spinner tags without circular imports.
- `src/server.js` — calls `liveStatus.enable()` after the boot banner, `liveStatus.disable()` on SIGINT.
- `src/claude-runner.js`, `src/lib/validators.js` — dropped `import ora from 'ora'`; replaced with `liveStatus.set/update/delete`. `ora` is still a dep for `src/commands/qa-handoff.js` (CLI single-spinner usage, unaffected).

**Per-run override:**

```bash
ORCHESTRATOR_NO_SPINNER=1 npm run server   # plain start/done lines, no live region
```

Non-TTY (logs piped to file) auto-suppresses the live region; `runClaude` and validator loops emit explicit `▸ task starting…` and `✓ task done` lines instead so the audit trail is preserved.

**Verify:** `scripts/demo-spinner.mjs` for a three-worker concurrent demo. `scripts/smoke-spinner.mjs` for a boot-time integration check.

---

## Transient-error retry classification (v0.14.10)

**What:** Two pre-existing bugs in `src/claude-runner.js` surfaced during dogfooding:

1. `TRANSIENT_PATTERNS` matched Node's `socket hang up` wording but not the Claude CLI's `socket connection was closed unexpectedly`. Socket-drop errors from the CLI died after a single attempt instead of being retried up to 3×, burning the API cost on a transient.

2. `inferHint()` matched any occurrence of `permission` or `denied` in the error message — including the always-present `"permission_denials":[]` JSON field name. Every CLI failure surfaced the hint "Permission denied. Check .claude/settings.json…" regardless of actual cause.

**Fix:**
- Added `/socket.*closed/i` and `/connection.*closed/i` to `TRANSIENT_PATTERNS`. Existing patterns untouched, no regression on cases that were already being retried.
- Rewrote `inferHint()` to fire the permission hint only on (a) non-empty `permission_denials` array, (b) `\bpermission denied\b` with word boundaries, (c) OS-level `EACCES`, or (d) "operation not permitted".
- Added a new `inferHint` branch for transient socket/connection-drop errors that DO exhaust retries — points at network rather than `.claude/settings.json`.

**Verify:** `node scripts/verify-v0_14_10.mjs` — 16 assertions. Feeds the exact JSON payload from the failed dogfood job into the patched logic and confirms positive + negative cases.

---

## `/req_promote` fast lane (v0.14.11)

**What:** Batch fast-lane for the requirements pipeline, parallel to `/bug_promote`. Closes the ergonomics gap that forced multi-item inbox flows through shell loops.

**Usage:**

```
/req_promote <inbox> <destination>          Promote scope=now items
/req_promote <inbox>                         Use last-used destination,
                                             or show project picker
/req_promote <inbox> <destination> --plan    Also queue brief + guide
```

With `--plan`, the orchestrator enqueues `brief` and `guide` jobs after the promote completes; both go through the same worker pool as `/run`, so per-project FIFO + v0.14.8 `enqueueAndReply` queue context apply. The expensive `go` step stays manual — user must `/run go &lt;destination&gt;` after reviewing the plan.

**Also added:**
- Inline `📋 Promote all (N) →` button on `/inbox &lt;project&gt;` — taps through a destination picker (real projects only, last-used starred), then a two-option confirm: `📝 Promote only` or `🧭 Promote + brief + guide`.
- CLI `npm run req -- promote-to &lt;inbox&gt; &lt;destination&gt;` — convenience wrapper that auto-derives the raw-thoughts.md path from the destination project name and auto-scopes unassigned items.
- Lazy-created `inbox_destinations` table (kv: `inbox_project → destination_project`) so repeated promotes from the same inbox don't re-prompt.

**Also fixed in the same patch:** 11 reversed-arg `npm run <bug|req> -- ${project} &lt;verb&gt;` hints in `src/lib/next-actions.js` and `src/server/telegram-handlers.js`. The actual CLI grammar is `&lt;verb&gt; &lt;project&gt;`. Now every hint is copy-pasteable.

**Verify:** `node scripts/verify-v0_14_11.mjs` — static regex checks for the hint-arg shape + dynamic SQLite sandbox that exercises `performReqPromote`, the autoScope path, and the `_inbox→real-project` and `_inbox→_inbox` refuse-paths.

---

## `_inbox` refine FK fix (v0.14.12)

**What:** `npm run req -- refine _inbox` crashed with `FOREIGN KEY constraint failed` AFTER the Sonnet call had already consumed ~$0.05 of tokens. `cmdRefine` passed the literal project name (`_inbox`) to `runClaude`, which on success called `upsertSession({ project: '_inbox', … })`. The `sessions` table has `FOREIGN KEY (project) REFERENCES projects(name)` and `_inbox` is a virtual project that doesn't exist as a row in `projects` — so SQLite aborted the transaction after the API spend, before any item was marked refined.

**Fix:** One line in `src/commands/requirements.js` — pass `project: null` to `runClaude` when the source project is `_inbox`. `claude-runner.js` already wraps every project-bound write with `if (returnedSessionId && role && project)`, so null is safe — session bookkeeping just skips. Refinement loop then writes `refined_text` and flips status normally.

**Workaround if you hit this on v0.14.10/v0.14.11:** The 10 items are still in `_inbox` with `status='inbox'` (never refined). After upgrading to v0.14.12, just re-run `npm run req -- refine _inbox`. Or for v0.14.10 specifically, bulk-reassign to a real project first:

```bash
for id in $(sqlite3 state/orchestrator.db \
  "SELECT id FROM requirements WHERE project='_inbox' AND status='inbox'"); do
  npm run req -- set $id project billflow-tds
done
npm run req -- refine billflow-tds
```

**Verify:** `node scripts/verify-v0_14_12.mjs` — 5 assertions against `src/commands/requirements.js`.

---

## Full Telegram workflow (v0.14.11+)

Putting the new fast-lane together, the full path from a freshly generated roadmap to a running dev cycle is three Telegram interactions:

```
# 1. From CLI — seed the inbox directly under the project (skip _inbox)
npm run roadmap-accept -- <project> --all --to-inbox <project>

# 2. From Telegram — refine, promote, plan in one tap
/req_promote <project> <project> --plan
   ↓ orchestrator runs:
     - refine the inbox items via Sonnet
     - promote scope=now items into raw-thoughts.md
     - queue brief + guide jobs

# 3. After brief + guide notifications arrive, review the plan, then:
/run go <project>
```

The `_inbox` virtual project is for ad-hoc captures that don't yet belong to a project. For roadmap items that DO belong to a known project, `--to-inbox &lt;project&gt;` (same project name) is the right pattern — items land directly under that project where refine/promote work without indirection.

---

# Cost & Quality Overhaul — v0.14.34 → v0.14.46

The releases below form one arc: cut Opus spend ~50% (driven by a live 30-day `/spend` report) while raising code quality, then harden the unattended night-run loop until a single button press can carry a project from audit to ship-ready with no human in the middle. Knobs live in `config/defaults.json` (`auto_run`, `audit`, `phases`, `fixes`, `validators`) and `config/model-routing.json`; all are overridable per-project via `projects/&lt;name&gt;/project.json` → `overrides`.

## Spend visibility — `/spend` (v0.14.34)

`/spend [days] [project]` (aliases `/spent`, `/costs`) — actual spend from the `calls` table, grouped task × model, for the trailing window (default 30d). The measurement counterpart to `/predict` (estimate) and `/budget` (lifetime cap). Both args optional and order-free: a bare number is the day window, any other token is a project. Read-only.

## Severity-gated promote (v0.14.34)

Audits used to promote findings at any severity into fix rounds — the single biggest source of churn (a live report showed 540 fixes/month, mostly MINOR). Now only **CRITICAL/MAJOR** findings auto-promote into a bugs round. **MINOR/DEFERRED-OK** append to `.guide/audit-backlog.md` (headings `### M1 —` / `### D1 —`, never `Bug N`, which the promote parser scans for). A clean audit writes exactly `(nothing to promote — no CRITICAL or MAJOR findings)`, detected deterministically to end the chain. Promote a backlog item later by copying it into a round's `bugs.md` (or use `/addbug`).

## Incremental re-audits (v0.14.34)

After a successful audit, the workspace HEAD is stamped to `.guide/audits/.last-audit.json`. The next audit scopes to the git diff since that SHA plus verification of prior findings, instead of re-reading the whole tree. Full-scope fallback when: no marker, not a git repo, the SHA is gone (rebase/force-push), or the diff exceeds 150 files. **Delete `.last-audit.json` to force a full re-scan** — useful when HEAD hasn't changed across several audits and you want a fresh full pass.

## Two-stage full audits (v0.14.36)

Full audits split into two calls: a **Sonnet scan** (`audit-scan`, its own `/spend` row) reads the codebase and over-reports `### CAND-n` candidates with file:line evidence to `.guide/audits/scan-&lt;ts&gt;.md`; then an **Opus adjudication** judges only that candidate list — confirms with final severity, kills false positives (with a `## Killed candidates` section naming each kill and why), merges duplicates, writes the final audit. Opus input drops from O(codebase) to O(findings). Incremental re-audits stay single-call. Disable with `audit.two_stage: false`. If real bugs are being demoted, read the Killed-candidates section — that's where the adjudicator's calls are visible.

## Validator hard gate (v0.14.35)

After a dev/fix agent commits, a gate runs **inside** `runDev` before the phase/fix is marked complete: configured `validators.json`, else a default gate (`npm test` when a real test script exists, else `node --check` on changed JS). One mechanical retry on failure; still failing → the phase/fix is marked failed and pauses (commit stays local, never pushed). A red or slow (`>180s` = fail) suite will fail every gate — set `overrides.validators.default_gate: false` per-project to bypass while you fix the suite. Knobs: `validators.default_gate`, `default_test_timeout_ms` (180000), `default_check_timeout_ms` (30000).

## Inline phase & fix prompts (v0.14.35 / v0.14.37)

Per-phase and per-fix prompt-generation guide calls are eliminated by default. `runDev` builds the prompt directly from the plan/round spec (`phases.inline_phase_prompts`, `fixes.inline_fix_prompts`, both default true) — a `prompt.md` on disk always wins. This removed two of the largest spend rows (`phase-prompt-gen`, `fix-prompt-gen`, the latter writing ~1:1 output volume with the fixes themselves).

## Routing: failure-driven escalation, scoped (v0.14.36 / v0.14.37)

`prefer_top_for_critical` retired (complexity scoring was a weak escalation proxy). Opus escalation is now **failure-driven**: a dev/fix that fails leaves `.guide/&lt;phase|fix&gt;-…-escalate-opus.marker`, and its next attempt runs Opus regardless of routing; cleared on completion. Escalation (keyword + complexity) applies **only** to execution tasks — new top-level `escalation_tasks` in `model-routing.json` (default `["dev-execution","fix-execution"]`). This stopped overhead tasks (prompt-gen, review, bug-plan) being force-tier'd to Opus by the *title* of the phase they merely referenced. Haiku retired from routing. The narrow `force_tier` rules (regulatory-core, security-core) are unchanged.

## Plan validation with auto-regen (v0.14.36 / v0.14.41)

`src/lib/plan-validate.js` mechanically validates every generated plan (numbering duplicates/gaps/order, required fields, acceptance criteria, reachability vs `current_phase`) — free, no model call. Problems → the list is written to `.guide/plan-fix.hint`, the plan regenerates once with it injected, re-validates; still broken → pause instead of executing a dead plan. The coverage gate auto-regens once on the first BLOCKER too. The gate is the shared `ensureValidPlan()`, applied on both the executeAction and pipeline plan paths.

## Self-healing night runs (v0.14.38 / v0.14.39 / v0.14.40 / v0.14.41)

- **In-run Opus retry:** the first non-timeout dev/fix failure retries immediately on Opus (no pause); pause only if Opus also fails. `auto_run.auto_escalate_on_failure` (default true).
- **Validation-failed markers** block a failed commit from being reconciled as "complete" on resume, and ride the failure excerpt into the retry prompt ("fix FORWARD").
- **Honest notifications:** pause messages use the orchestrator's reason (validator gate / no-commit), not the agent's "Done…" text, and label fixes correctly (`fix r2-3`, not `phase-undefined`). Clean audits read as success, not "chain stopped".
- **Every guide result is checked:** audit, brief-author, plan, roadmap, review, handoff — a failed guide call fails the job honestly instead of reporting ✓ with no artifact. (A swallowed audit result had been masquerading as "duplicate audit", killing `×3/×5` chains.)

## ♾ Until clean + double-failure parking (v0.14.43)

- **♾ Until clean** (audit menu, or `--rounds=inf`): the audit→fix→re-audit chain loops until an audit comes back clean, instead of a fixed ×N. Safety ceiling `auto_run.max_chain_rounds` (default 25).
- **`auto_run.on_double_failure: "skip"`** (opt-in; default `"pause"`): when Sonnet AND the Opus retry both fail the same FIX, park it to the round's `parked.md` and continue the round; the next audit re-surfaces the bug. Phases never skip (N+1 builds on N).

## Audit chains drain manual rounds (v0.14.42)

A clean audit no longer ends the chain past a manually dropped `bugs.md` on disk — the chain detects the pending round, runs its fixes unattended, then re-audits. CLI and server chains both.

## Deferred transient retries (v0.14.44)

Layered atop the v0.14.10 in-process runner retry: when a **job** fails (or an auto-run pauses) on external weather — rate limit, overload (429/529), 5xx, network drop, billing window — the identical job re-enqueues with `not_before = now + transient_retry_minutes` (default 60) and runs again when due, recursively, until it works. DB-backed (`tg_jobs.not_before`, `retry_count`), so it survives restarts; sleeping retries are invisible to the picker and don't block the project FIFO. Auth/key errors are deliberately **not** transient (need a human); validator/no-commit/plan failures keep their own flows. Knobs: `retry_transient` (true), `transient_retry_minutes` (60), `transient_retry_max` (0 = unlimited).

## `/addbug` + dropped-round safety net (v0.14.45)

`/addbug &lt;project&gt; &lt;title&gt;` (aliases `/add_bug`, `/newbug`) — the orchestrator computes the next round number, creates `projects/&lt;p&gt;/.guide/bug-rounds/round-N/` at the correct path, and writes a canonical `### Bug #1` stub, returning a "▶ Run fixes" button. No more hand-typed heredocs landing in the wrong directory. The project card also flags a round whose `bugs.md` exists on disk without a fix-plan ("on disk but not yet run — tap ▶ Go"), so a dropped round can't hide behind repeated clean audits.

## Clean-audit names the QA-pending round (v0.14.46)

When an audit chain ends clean but the most recent fix round is completed and unshipped (working branch ahead of main), the ✅ message appends "→ bugs round N is fixed and awaiting your re-test — then `/ship`", instead of going silent about the one thing that needs you.
