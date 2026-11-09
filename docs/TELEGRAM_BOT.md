# Telegram Bot

The orchestrator ships a long-running server (`npm run server`) that hosts a
Telegram bot for remote control: project status, queue management, push
notifications, and full requirement/bug pipelines. Current as of v0.14.46.

**New here?** Read [`PLAYBOOK.md`](./PLAYBOOK.md) first — six concrete
scenario walkthroughs ("you type X, bot replies Y, you tap Z"). Then
send `/coach` from your bot for state-aware "what to do next"
suggestions.

## Setup

### 1. Create the bot in Telegram

1. Open Telegram, message `@BotFather`
2. Send `/newbot`, follow prompts (pick a name, a unique handle)
3. BotFather replies with a token. Looks like `1234567890:ABCdef-GhI...`
4. Copy the token. **It's a credential — treat like a password.**

### 2. Configure the orchestrator

```bash
cd ashmero-orchestrator
npm install                        # installs grammy + express (new deps)
npm run migrate-all                # creates all required SQLite tables
npm run bot-setup -- --token "<paste-bot-token-here>"
```

Default mode is `polling` (works on Mac without exposing a public URL). When you move to NAS with a Cloudflare tunnel or similar, switch to webhook:

```bash
npm run bot-setup -- \
  --token "<token>" \
  --mode webhook \
  --webhook-url https://orch.your-domain.com \
  --webhook-port 3434
```

### 3. Start the server

```bash
npm run server
```

You should see:

```
═══ Orchestrator Server ═══

✓ Bot starting (polling mode)
✓ Bot online: @your_bot_handle

Job processor running. Press Ctrl-C to stop.
```

### 4. Allowlist yourself

Open your bot in Telegram, send `/start`. It tells you to send `/auth &lt;code&gt;`.

In a SECOND terminal on your Mac (keep `npm run server` running in the first):

```bash
npm run bot-auth-code -- --label "Prem main"
```

Outputs:

```
  Auth code: ABC123

  In Telegram, send to your bot:
    /auth ABC123

  ⚠  Code expires in 15 minutes.
  ⚠  Server must be running for the code to be accepted.
```

In Telegram, send `/auth ABC123`. Bot replies `✓ Authorized.`

You're now allowlisted. Send `/start` again to see the full command menu.

## Commands

Every command registered on the bot, grouped by what it touches.

### Read-only

| Command | What it does |
|---------|--------------|
| `/start` | Onboarding banner + command index. Different content if you're not yet allowlisted. |
| `/auth &lt;code&gt;` | Use a single-use code (from `npm run bot-auth-code`) to allowlist yourself. |
| `/help` | Categorized command overview. `/help &lt;topic&gt;` for a deep dive on `req`, `triage`, `validators`, `bugs`, `git`, `preview`, `notifications`, `pin`, `new_project`. |
| `/docs` | List the doc files shipped with the orchestrator; open one with `/docs &lt;name&gt;`. |
| `/status` | Current running job(s), per-project queue depth, budget window. |
| `/projects` | All registered projects with status + per-row action buttons. |
| `/project &lt;name&gt;` | Detail view for one project: phase, last run, queue, action buttons. |
| `/queue` | Show the FIFO queue across all projects with elapsed time per active job. |
| `/users` | Allowlist roster. |
| `/history` | Last 15 jobs with status + summary. |
| `/pinned` | The project pinned to your Telegram user (default for argless commands). |
| `/git_status &lt;project&gt;` (alias `/git`, `/gitstatus`) | Local repo HEAD + ahead/behind vs origin. |
| `/preview &lt;project&gt; &lt;kind&gt;` | Stream a generated doc into Telegram (paginated). Kinds: `brief`, `plan`, `audit`, `bugs`, `roadmap`. |
| `/files &lt;project&gt;` | List files at a path inside the project workspace. |
| `/file &lt;project&gt; &lt;path&gt;` | Show one file (paginated). |

### Job control (require allowlist)

| Command | What it does |
|---------|--------------|
| `/run &lt;project&gt; &lt;action&gt;` | Enqueue a job; same FIFO as `/queue`. v0.14.x runs concurrent jobs across projects via the auto-scaling worker pool, but one at a time per project. v0.14.18: `/run` with no args opens a project-then-action picker. |
| `/queue &lt;project&gt; &lt;action&gt;` | Identical to `/run`; kept as a clearer-named alias. |
| `/cancel [&lt;project&gt;]` | Stop a running job. With one job running and no arg, asks for confirmation. With two or more (since v0.14.8), shows an inline picker. Pass a project name to scope directly. |
| `/dequeue &lt;job-id&gt;` | Remove a pending (not-yet-running) job from the queue. |
| `/download &lt;job-id&gt;` | Send the per-job stdout/stderr logs as Telegram files. |
| `/sync &lt;project&gt;` (alias `/pull`, `/gitpull`) | `git fetch && git pull --ff-only` on the project workspace. |
| `/ship &lt;project&gt;` (alias `/shipproject`) | Fast-forward `main` to `develop`. Requires confirmation. |
| `/new_project &lt;name&gt; &lt;git-remote&gt;` (aliases `/newproject`, `/import`, `/addproject`) | Register a project; clones the remote into `projects/&lt;name&gt;/workspace/`. |
| `/pin &lt;project&gt;` / `/unpin` | Pin a default project for your user so `/inbox`, `/triage`, etc. work without a project arg. |

Actions for `/run` and `/queue`: `go`, `resume`, `audit`, `bugs`, `roadmap`, `brief`, `guide`, `next`, `review`, `handoff`, `qa`, `ship`, `pipeline`, `reset-brief`.

The `guide` action defaults to the `plan` task. To run another guide task over the queue, pass `--task <type>`, e.g. `/run myproj guide --task next-prompt`. Queue-safe tasks (need only project state + on-disk files): `plan`, `next-prompt`, `review`, `handoff`, `workspace-claude-md`. Tasks that need extra context — `bug-plan` (round), `fix-prompt` (round + fix id), `requirement-refine` (the requirement) — stay CLI-only; the bot rejects them with a pointer to `npm run guide -- <project> --task <type>` rather than enqueue a job that would fail.

### v0.14.19 coach + UX

| Command | What it does |
|---------|--------------|
| `/coach [&lt;project&gt;]` (aliases `/next`, `/whatsnext`, `/whats_next`) | State-aware "what should I do next?" suggestion. Looks at file existence, SQLite state, inbox counts, recent audits, etc., and returns the single most useful next move as a sentence + tappable buttons. Designed for newcomers and "I forgot where I was" recovery. |

The `/start` welcome screen now leads with a 🧭 **What now?** button that
runs `/coach` against your pinned project. Combined with
[`docs/PLAYBOOK.md`](./PLAYBOOK.md), this is the recommended entry path
for users new to the orchestrator.

### v0.14.18 parity commands

CLI commands that previously had no Telegram equivalent. All wrap the
existing CLI command modules — no separate logic, no schema changes.

| Command | What it does |
|---------|--------------|
| `/predict &lt;project&gt;` | Predict cost of upcoming work without making any calls. Renders the compact prediction table in `&lt;pre&gt;` for monospace alignment. |
| `/spend [&lt;days&gt;] [&lt;project&gt;]` (aliases `/spent`, `/costs`) | ACTUAL spend from the `calls` table, grouped task × model, for the trailing window (default 30d). The measurement counterpart to `/predict` (estimate) and `/budget` (cap). Args order-free: a bare number is the day window, any other token is a project. Read-only. |
| `/budget &lt;project&gt;` | Lifetime per-project spend + cap (distinct from `/status`'s 5h rolling window). Shows a Unicode progress bar. |
| `/promote &lt;project&gt;` | Promote audit findings into a new bug round. Reads most recent audit, extracts `Promote to bugs-round-N` section, shows confirmation with target round + audit filename, writes `bug-rounds/round-N/bugs.md` on tap. Mirrors `npm run promote -- --from-audit`. |
| `/inspect &lt;project&gt; [&lt;phase&gt;]` | Phase picker if no phase given; otherwise shows the phase report inline with `📊 Diffstat` and `📄 Full diff as file` buttons. Mobile-readable defaults. |
| `/retry &lt;project&gt; &lt;phase&gt;` | Destructive: resets phase to pending and reverts workspace to parent commit. Dry-run preview + confirmation button. |
| `/qa_handoff &lt;project&gt;` (alias `/qahandoff`, `/handoff_qa`) | Generates tester-facing markdown via `generateQaHandoff` with `--with-steps`, DMs as file. |
| `/validate &lt;project&gt;` | Run all registered validators against the workspace. Uses `{ always: true }` event matcher. |
| `/validators &lt;project&gt;` | Show last 15 validator runs with pass/fail glyph. |
| `/dashboard` | Generate orchestrator-wide HTML telemetry dashboard, DM as file. No project arg — cross-project view. |
| `/package &lt;project&gt;` | Zip a project (workspace + `.guide`) and DM it. Surfaces clear error if size exceeds Telegram's 50 MB cap. |

### v0.14.18 UX changes (no command surface changes)

- `/start` for allowlisted users is now a live-status sentence ("Idle"
  vs "2/4 workers busy on …") with four inline buttons (Status,
  Projects, Run, Help) and the canonical "Actions for /run" footer.
  The wall-of-text command list it used to show is now reachable via
  the 📚 Help button.
- `/help` is now a button TOC over `HELP_TOPICS`. The `/help &lt;topic&gt;`
  deep-dive paths are unchanged.
- `/run` with no args opens a fresh project-then-action picker (built
  from `VALID_ACTIONS`, state-aware) rather than asking you to pin
  first. The pinned-flow `/run go` still works.

### v0.14.28 extend flow + brief questions

| Command | What it does |
|---------|--------------|
| `/extend [&lt;project&gt;]` (aliases `/add_work`, `/add`, `/more`) | Interactive decision tree for adding new work to a finished project. Presents three paths — small refinements/QA fixes (→ bug capture mode), new features (→ edit brief + regenerate phases), big new direction (→ `/new_project` instructions) — plus a "Help me decide" option. Shows the current phase progress so you can see whether the project is mid-build or complete. |
| `/brief_questions [&lt;project&gt;]` (aliases `/briefquestions`, `/bq`) | Show `.guide/brief-questions.md` with an unresolved-marker count. When all `[NEEDS USER INPUT]` markers are gone, offers a one-tap "Start planning (go)" button. Buttons to re-run the brief-author or view `brief.md` are always present. |

### Requirements inbox

| Command | What it does |
|---------|--------------|
| `/req &lt;project&gt; &lt;text&gt;` | One-shot capture: append a raw requirement to that project's inbox. With no project, captures into the magic `_inbox` virtual project. |
| `/capture &lt;project&gt;` | Enter multi-message capture mode. Every subsequent non-slash message becomes a requirement attached to that project. |
| `/done` | Exit capture mode. |
| `/inbox [&lt;project&gt;]` | Browse a project's inbox (pinned project if no arg). Includes a `📋 Promote all (N) →` button for batch flow (v0.14.11+). |
| `/triage &lt;project&gt;` | One-item-at-a-time triage with inline `p0/p1/p2/p3 · now/next/later/no · skip/drop/done` buttons. Auto-advances. |
| `/req_promote &lt;inbox&gt; &lt;destination&gt; [--plan]` (alias `/reqpromote`, v0.14.11+) | Batch fast-lane: auto-flips unassigned → scope=now, promotes into `&lt;destination&gt;`'s `raw-thoughts.md`, remembers the destination for next time. With `--plan`, also queues `brief` + `guide` jobs (stops before `go` so you can review the plan). |

### Bugs inbox (parallel pipeline to requirements)

| Command | What it does |
|---------|--------------|
| `/bug &lt;project&gt; &lt;text&gt;` | Capture a bug into the project's bug inbox. Accepts `critical:`, `major:`, `minor:` prefixes. |
| `/bug_capture &lt;project&gt;` (alias `/bugcapture`) | Multi-message capture mode for bugs. |
| `/bug_done` (alias `/bugdone`) | Exit bug-capture mode. |
| `/bugs_inbox [&lt;project&gt;]` (aliases `/bugsinbox`, `/buginbox`) | Browse pending bugs with batch promote / severity-promote buttons. |
| `/bug_promote &lt;project&gt;` (alias `/bugpromote`) | Promote ALL pending bugs into a new bug round AND queue a `bugs` job to start the fix cycle. Critical-only variant: `/bug_promote &lt;project&gt; --critical`. |
| `/addbug &lt;project&gt; &lt;title&gt;` (aliases `/add_bug`, `/newbug`) | Create the next manual bugs round at the correct path (`projects/&lt;p&gt;/.guide/bug-rounds/round-N/bugs.md`) with a canonical `### Bug #1` stub. Returns a "▶ Run fixes" button. Replaces hand-creating round directories. Edit the stub (or call again for more bugs in the same round), then `/run &lt;p&gt; go`. |

### Inline buttons

`/projects`, `/project`, `/inbox`, `/bugs_inbox`, `/triage`, and project-detail views all surface inline keyboards. Common patterns: action buttons (Run / Resume / Go / Audit / Bugs / Roadmap), pagination, promote+run shortcuts, and confirmation prompts for destructive ops (`/cancel`, `/ship`, `/dequeue`).

**Audit button (project card → 🔍 Audit):** opens a menu — *Audit only* (produce the document, stop; you promote manually), *Auto ×1 / ×2 / ×3 / ×5* (audit → promote CRITICAL/MAJOR → run every fix → re-audit, up to N rounds, stops early on a clean audit or a blocker), and *♾ Until clean* (the same loop with no fixed count, until an audit comes back clean; safety ceiling `auto_run.max_chain_rounds`, default 25). A clean audit that sits on a manually dropped round drains it first (v0.14.42); a clean audit on a completed-but-unshipped round names it for re-test + ship (v0.14.46).

### Autocomplete dropdown (`/`)

The bot registers a curated subset of commands as the Telegram `/`-autocomplete dropdown via `bot.api.setMyCommands(...)` at every server boot (v0.14.15+). The list lives in `src/lib/command-menu.js` — ~20 high-frequency commands; aliases and admin/debugging ones are deliberately omitted. To change what shows in the dropdown, edit the `COMMAND_MENU` array and restart the server. The `scripts/verify-v0_14_15.mjs` checker enforces that every menu entry has a corresponding `bot.command(...)` registration, so the dropdown can never point at a non-existent command.

You do NOT need to maintain `/setcommands` in BotFather anymore. The orchestrator overwrites whatever's there on every boot.

## Push notifications

The bot DMs every allowlisted user when:

- A job is enqueued (`▶ Queued #N: action project`) — with FIFO context if waiting behind another job on the same project (v0.14.8+)
- A job starts (`▶ Starting: action project`)
- A job pauses at a checkpoint (`⏸ ... paused`)
- A job completes (`✓ Completed: action project`)
- A job fails (`✗ Failed: action project`) — includes the inferred hint (v0.14.10 fixed the false-positive permission hint)
- The server starts (`🟢 Online`)
- The server shuts down (`🔴 Shutting down`)

If multiple users are on the allowlist, all get notified. No way to mute per-user yet — add a label and filter on the receiving end if it matters.

## Architecture

The server holds the Telegram connection AND runs jobs in-process via an N-worker pool (v0.14.0+). Per-project FIFO; cross-project concurrency. Workers auto-scale by project count, capped at 8 (`max_workers_cap` in `job_runner` config). Each worker runs inside an `AsyncLocalStorage` context so every `console.log` and the spinner row are prefixed with `[wN project]` automatically (v0.14.5 + v0.14.9 LiveStatus). Claimed jobs carry a renewable SQLite owner lease; after a crash, server startup requeues replay-safe stale work and resumes partial `go`/`next` work instead of silently dropping it.

```
Telegram → bot (grammy) → handler → enqueue → SQLite tg_jobs
                                                     ↓
                          server.js pool ←───────────┘
                          (N workers, FIFO per project)
                                ↓
                          job-runner.js → autoRun() / runGuide() / startBugCycle() / performReqPromote()
                                ↓
                          notifier.js → bot.api.sendMessage to allowlisted users
```

## Known limits (v0.14.x)

- Mid-phase cancellation is a real per-job hard-cancel: the targeted job's Claude subprocess is sent `SIGTERM` (then `SIGKILL` after 5s), and the DB row is marked `cancelled`. `killCurrent` keys the process handle and the cancel flag by `jobId` (from the worker context), so under the concurrent worker pool `/cancel <A>` only ever kills A's subprocess — never a sibling job's. The terminal `cancelled` row is protected: a late completion from the dying subprocess can't overwrite it (`markJobCompleted`/`markJobFailed` are guarded to `status='running'`). Note the workspace still reflects only what was committed before the cancel — mid-phase file writes may have partially landed, so check `git status`.
- File downloads (`/download &lt;job-id&gt;`) are limited to 50 MB by Telegram. The orchestrator truncates aggressively on the server side; check the Mac filesystem for full logs if needed.
- Webhook URL doesn't auto-renew if the Cloudflare tunnel restarts — re-run `npm run bot-setup` manually.
- Live log streaming over Telegram isn't supported (too verbose); use `/preview` for static doc snapshots instead.

## Going to NAS later

When you move to an always-on host:

1. Token-copy your Mac's `~/.config/claude/credentials.json` to that host
2. Install the orchestrator on the host, run `npm install`
3. Set up a Cloudflare tunnel: `cloudflared tunnel --url http://localhost:3434`
4. Get the public URL, run `npm run bot-setup -- --mode webhook --webhook-url &lt;url&gt;` on the host
5. Disable the Mac server (`pkill -f 'orchestrator.js server'`)
6. Start the server as a systemd service

Notifications continue to work — your Telegram user_id doesn't change, allowlist persists in SQLite.

## Security notes

- Bot token in `config/telegram.json` — gitignored already
- Only allowlisted Telegram user_ids can issue commands
- Auth codes are 6 chars, single-use, 15-min expiry, kept in server memory only (survive nothing)
- Destructive operations (`ship`, `cancel`) require confirmation buttons
- All command handlers validate project existence before queueing
- Mid-phase cancellation is a per-job hard-cancel (SIGTERM→SIGKILL to that job's subprocess, marks DB row `cancelled`); `killCurrent` is keyed by `jobId` so it's safe under the concurrent worker pool

## Common issues

**"Bot is online but doesn't respond"** — verify the token is correct, check `config/telegram.json`. Check server logs for `[bot error]` lines.

**"Auth code expired"** — generate a new one. Server doesn't persist codes across restarts.

**"Job queued but never starts"** — check that the server is running. Without process-level launchd/systemd/NAS supervision, jobs correctly remain durable in SQLite but no worker exists to claim them. SQLite query: `sqlite3 state/orchestrator.db "SELECT id,project,action,status,worker_pid,lease_expires_at FROM tg_jobs WHERE status IN ('pending','running');"`

**"Got notifications then they stopped"** — check the server logs. Common causes: orchestrator process crashed, Telegram rate limit (rare with one user), bot token revoked.
