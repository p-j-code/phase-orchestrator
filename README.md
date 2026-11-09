# Phase Orchestrator

**A phase-based development pipeline on top of Claude Code: a guide agent plans and reviews, a dev agent builds, and git commits mark every step.**

You write a brief. The orchestrator turns it into a phased plan, runs each phase in
a fresh Claude Code session, commits the result, checks it against the phase's
acceptance criteria, has the guide review every few phases, and pauses at
checkpoints for you to look. When bugs turn up, they get their own fix cycle. When
the guide's context fills up, it writes a handoff and continues in a new session.

It was built around one rule: **recoverable before autonomous.** Every run is
durable, every phase is a commit you can inspect or revert, and the system stops
rather than guesses when something looks wrong.

```text
brief ─▶ plan ─▶ [ phase prompt ─▶ dev session ─▶ commit ─▶ verify ] × N ─▶ review ─▶ … ─▶ ready for QA
                         ▲                                                   │
                         └──────────── handoff when guide context fills ─────┘
```

> Status: personal tool, used daily, now open-sourced. Expect rough edges. Issues and PRs welcome.

---

## Why

Building with an AI coding agent by hand usually looks like this: ask one chat for a
plan, paste each phase prompt into a new session, shuttle the code back for review,
and start over when the context gets long. It works, but you are the scheduler, the
memory and the QA loop.

The orchestrator automates that loop without hiding it. Plans, prompts, reports and
reviews are plain files in `.guide/`, and code changes are ordinary git commits in
`workspace/`. You can read, edit or replay any of it.

## How it works

| Piece | What it does |
|---|---|
| **Two agents, two sandboxes** | The *guide* (planning, reviews, handoffs) writes only to `.guide/`. The *dev* agent writes only to `workspace/`. Each is a separate `claude -p` subprocess with its own system prompt and working directory. |
| **Git as phase boundaries** | Each dev phase ends in a commit. Lanes use git worktrees, so parallel work never shares a checkout. |
| **Guide continuity** | The guide's session ID is stored and resumed across phases. When its context grows too large, it writes a handoff and a fresh session picks up from there. |
| **Verification** | Validator gates (tests, syntax checks, configured chains) run after every commit, plus an acceptance-criteria check against `plan.json`. A periodic guide review catches drift. |
| **Durable queue** | Jobs live in SQLite with renewable leases. Kill the worker mid-phase and it reconciles and resumes on restart. |
| **Budget awareness** | Every call's tokens, cost and duration are recorded. Usage in the rolling 5-hour window is tracked, and runs pause before limits instead of failing halfway. A shared circuit breaker stops a burst of rejected calls from cascading. |
| **Cache-friendly prompts** | Stable context goes in the system prompt and per-call context goes in the user prompt, so prompt caching keeps working across a long run. A deterministic repo map replaces LLM-written file inventories. |
| **Config cascade** | defaults → user → profile → project → phase, validated with JSON Schema. Bad overrides fail loudly at load time. |

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/AUTO_RUN.md](docs/AUTO_RUN.md),
[docs/VERIFY_LOOP.md](docs/VERIFY_LOOP.md), [docs/PARALLEL_EXECUTION.md](docs/PARALLEL_EXECUTION.md).

## Interfaces

- **CLI:** `node src/orchestrator.js <command>` or the `npm run` aliases below
- **Web dashboard:** live projects, phases, calls, queue and logs (`npm run ui`, port 4242, token-protected)
- **Telegram / Discord bots** (optional): start runs, add requirements and check status from your phone
- **MCP servers** (off by default): expose orchestrator state and controls to Claude sessions

## Requirements

- Node.js 18+ and git
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and logged in (`claude` on your PATH)

The orchestrator drives your own Claude Code login. It deliberately unsets
`ANTHROPIC_API_KEY` in subprocesses, so it never falls back to pay-as-you-go API
billing by accident. Use it within the terms of your Claude plan. The chat bots are
meant for the account owner, not for sharing access with other people.

## Quick start

```bash
npm install
npm run init            # one-time user config + creates the SQLite schema
npm run doctor          # checks Claude Code auth and model selection

npm run new -- todo-cli --profile nodejs-microservice --tech "Node 22, TypeScript"
$EDITOR projects/todo-cli/.guide/brief.md   # describe what to build

npm run go -- todo-cli  # plan → phases → reviews, pausing at checkpoints
npm run resume -- todo-cli
```

Profiles live in `config/profiles/` (`react-vite`, `nextjs-saas`, `react-native-mobile`,
`nodejs-microservice`, and others).

## Common commands

| Command | What it does |
|---|---|
| `npm run go -- <name>` | Auto-run: plan → phases → reviews → ready for QA |
| `npm run resume -- <name>` | Resume after a checkpoint or pause |
| `npm run abort -- <name>` | Stop gracefully |
| `npm run status [-- <name>]` | Usage window and project state |
| `npm run predict -- <name>` | Estimate turns and cost before running |
| `npm run bugs -- <name>` | Start a bug-fix round from `.guide/bugs-round-N.md` |
| `npm run review -- <name>` | Force a guide review |
| `npm run handoff -- <name>` | Force a guide handoff |
| `npm run ship -- <name>` | Merge the project's develop branch into main |
| `npm run ui` | Start the web dashboard |

`--unattended` skips checkpoints (it still pauses on errors and budget limits).
`--dry-run` previews actions. Run `node src/orchestrator.js --help` for the full list.

## Project layout

```text
config/       defaults, JSON schemas, profiles, model routing
prompts/      guide and dev system prompts, templates, skills
src/          CLI, worker, runners, web UI, bots, MCP servers
  lib/        phase runner, verify loop, context compiler, git, queue logic
docs/         architecture and flow docs (VitePress: npm run docs)
eval/         prompt-evaluation fixtures and rubrics
projects/     your projects (git-ignored): .guide/, workspace/, inputs/, outputs/
state/        SQLite database and run state (git-ignored)
```

## Running it 24/7

`ecosystem.config.cjs` runs the web UI and the durable worker as separate PM2
processes, so restarting the dashboard never interrupts a run. Only one install
may execute work for a given Claude account. `config/execution-host.json` names
that install, and its defaults match a single local machine.

## Tests

```bash
npm test             # ~2,000 unit and integration tests (node:test)
npm run test:config  # config cascade self-test
```

## Blog post

[Building an orchestrator for Claude Code: recoverable before autonomous](docs/blog/recoverable-before-autonomous.md):
the design decisions behind this project and what broke along the way.

## License

[MIT](LICENSE) © 2026 Prem Jethwa
