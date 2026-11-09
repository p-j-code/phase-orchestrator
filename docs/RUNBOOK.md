# Runbook — day-to-day usage

## First-time setup

```bash
cd ~/dev/ashmero-orchestrator
npm install
npm run init                    # creates ~/.ashmero-orchestrator/user.json
bash scripts/preflight.sh       # confirms Max plan + no API key leak
```

Open VS Code: `code .`

## Start a new project

```bash
# Greenfield project
npm run new -- reelchain \
  --profile react-vite \
  --tech "React 18 + TS + Vite, FFmpeg, Puppeteer"

# Or with existing codebase
npm run new -- billflow --profile nextjs-saas --tech "Next.js 15 + TS"
# then extract your zip into projects/billflow/inputs/ and workspace/
```

This creates:

- `projects/&lt;name&gt;/.guide/`
- `projects/&lt;name&gt;/workspace/`
- `projects/&lt;name&gt;/inputs/`
- `projects/&lt;name&gt;/outputs/`
- `projects/&lt;name&gt;/project.json`

## Generate the phased plan

```bash
npm run guide -- reelchain --task plan --brief "$(cat ~/Desktop/brief.md)"
```

Guide produces `.guide/plan.json` (machine) and `.guide/plan.md` (human). Read the plan, edit if needed.

## Phase loop

```bash
# Generate phase N prompt
npm run guide -- reelchain --task next-prompt

# Review the prompt at projects/reelchain/.guide/phase-1-prompt.md
# Edit if needed, then run the dev phase

npm run next -- reelchain

# Dev agent executes, commits as 'phase-1: <summary>', writes phase-1-report.md
```

Repeat. Every 3 phases the orchestrator nudges you to review:

```bash
npm run review -- reelchain
```

Review reads `workspace/`, writes `.guide/review-after-3.md`, adjusts `plan.json` if needed.

## When guide context gets large

```bash
npm run handoff -- reelchain
```

Guide writes `.guide/handoff.md`. Next guide call automatically starts fresh, seeded from handoff.md.

## Check budget

```bash
npm run status                  # all projects + window state
npm run status -- reelchain     # focused on one project
```

## Pause / resume

If billing-guard pauses you (calls in window ≥ pause threshold), wait for the 5-hour window to roll over. Or temporarily raise `pause_at_calls` in `config/defaults.json` (not recommended).

## Per-phase overrides

Sometimes phase 7 of Reelchain needs Opus, not Sonnet. Edit `.guide/plan.json`:

```json
{
  "phases": [
    {
      "n": 7,
      "title": "Export worker fix",
      "model_override": "claude-opus-4-7",
      "max_turns_override": 80
    }
  ]
}
```

Resolver picks it up automatically on the next `npm run next`.

## Per-project overrides

Edit `projects/&lt;name&gt;/project.json`:

```json
{
  "overrides": {
    "phases": { "review_every_n_phases": 2 },
    "tools": {
      "allowed_default": ["Read", "Write", "Edit", "Bash", "WebFetch"]
    }
  }
}
```

## Troubleshooting

**"Phase prompt not found"**
Run `npm run guide -- &lt;project&gt; --task next-prompt` first.

**"ANTHROPIC_API_KEY is set"**
`unset ANTHROPIC_API_KEY`. Remove from `~/.zshrc` if persistent.

**Guide loses context mid-phase**
Run `npm run handoff -- &lt;project&gt;`. Then continue with normal commands.

**Want to redo a phase**
Manually edit SQLite: `sqlite3 state/orchestrator.db "UPDATE phases SET status='pending' WHERE project='X' AND n=Y; UPDATE projects SET current_phase=Y-1 WHERE name='X';"`. Then `npm run next`.

**Switch to interactive mode (post-June 15)**
Edit `config/defaults.json`: `"billing": { "mode": "interactive_tmux" }`. (Implementation of tmux mode TBD — currently the orchestrator only supports `max_pooled` and `agent_sdk_credit` modes; both spawn `claude -p`.)

---

# What's new since v0.6 — quick reference

See `CHANGELOG.md` for version-by-version detail and `docs/NEW_FEATURES.md` for the full how-to.

## New commands

```bash
# Automatic disk hygiene (runs at server boot + every 6h; ad-hoc available)
npm run cleanup [-- --dry-run --verbose]

# Per-project context — domain/audience/regulatory rules injected on every call
npm run context -- <project>

# Requirements inbox — capture thoughts anywhere, triage when ready
npm run req -- <project> add "..."          # capture
npm run req -- <project> list               # show inbox
npm run req -- <project> refine             # batched AI refinement (Sonnet)
npm run req -- <project> promote --scope now  # → appends to raw-thoughts.md
npm run triage -- <project>                 # fast keypress triage TUI

# Pre-flight cost prediction (integrated into go + resume too)
npm run predict -- <project>

# External validators (run automatically after every dev/fix)
npm run validate -- <project> --all
npm run validate -- <project> --fix 4.2     # ad-hoc, as if a specific event
npm run validators -- <project>             # history

# QA handoff — tester-friendly markdown
npm run qa-handoff -- <project>
npm run qa-handoff -- <project> --round 4 --with-steps

# New migrations (additive, idempotent)
npm run migrate-requirements
npm run migrate-validators
```

## New Telegram commands

```
/req <project> <text>           one-shot capture
/req <text>                     capture into _inbox
/capture <project>              enter multi-message capture mode
/done                           exit capture mode
/inbox [<project>]              browse + tap-to-triage
/triage <project>               fast triage with auto-advance
```

## New behavior in existing flows

- `npm run go` and `npm run resume` show cost prediction + budget impact before running; prompt y/N if predicted ≥ $1 or budget would exceed. Skip with `--no-predict` or `--yes`.
- Every claude subprocess shows a live spinner with elapsed time. In server mode with concurrent jobs (v0.14.9+), the spinner becomes a multi-row "live region" anchored at the bottom of stdout, one row per active worker tagged `[wN project]`. Suppress with `ORCHESTRATOR_NO_SPINNER=1`.
- On macOS, system stays awake during runs (caffeinate). No-op on Linux/NAS. Disable with `wake_lock.enabled: false`.
- Each action header in `npm run go` shows cumulative run time alongside per-call elapsed.
- On completion / pause / failure / Ctrl-C cancel: full summary block with start time, end time, wall time, calls breakdown, cost.
- After every dev/fix call, any matching validators run automatically. Failure pauses the run.
- Transient API errors (socket-drop, connection-closed, ECONNRESET, 5xx, rate limits) auto-retry up to 3× with backoff. If they exhaust, the failure message now correctly identifies it as a network issue rather than misleading the operator toward `.claude/settings.json` (v0.14.10+).
- The bot's `/req_promote &lt;inbox&gt; &lt;destination&gt; [--plan]` (v0.14.11+) is the requirements-side analog of `/bug_promote`. With `--plan` it also queues brief + guide jobs after the promote completes.

## New files in each project

These get created on demand (not on `npm run new`):

```
projects/<name>/.guide/project-context.md     # `npm run context`
projects/<name>/routing-extension.json        # hand-write or copy from billflow-tds
projects/<name>/validators.json               # hand-write
projects/<name>/validators/*.{sh,js}          # hand-write executable scripts
projects/<name>/.guide/qa-handoffs/           # `npm run qa-handoff`
```
