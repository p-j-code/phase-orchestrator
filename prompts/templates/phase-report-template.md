# Phase {N} Report — {project}

**Status:** COMPLETED | PARTIAL | FAILED
**Commit:** `<sha>`
**Tests:** `<pass>/<total>` passing

## Files changed

### Created
- `path/to/file.js` — one-sentence purpose

### Modified
- `path/to/file.js` — what changed and why

### Deleted
- `path/to/file.js` — reason

## Acceptance criteria

- [x] AC1: <restate criterion> — verified by: <how>
- [x] AC2: <restate> — verified by: <how>
- [ ] AC3: <restate> — NOT MET because: <reason>

## Acceptance criteria self-assessment

Mandatory — this is the criterion→evidence table from the work protocol's self-verify step. One row per acceptance criterion, filled in AFTER `git diff`, not from memory. The orchestrator parses this table to focus its own acceptance checker on whatever you flagged as uncertain — an honest "uncertain" here costs nothing; an inflated "done" the checker then catches costs a whole retry cycle.

| Criterion | Status | Evidence (file:line) | Confidence |
|---|---|---|---|
| <verbatim criterion text> | done \| partial \| uncertain | `path/to/file.js:42` | high \| med \| low |

- **Status** — `done` (you verified it against the actual diff), `partial` (some of it works, say what's missing), `uncertain` (you're not sure it holds, or couldn't verify it in this environment).
- **Evidence** — a real `file:line` (or line range) you can point the checker at. "Implemented in the service layer" is not evidence; `backend/services/fvuBuilder.js:88-104` is.
- **Confidence** — your own honest read, independent of Status. A `done` row can still be `med`/`low` confidence if you're not fully sure the evidence covers every edge case the criterion implies.

## Deviations from prompt

| Deviation | Reason |
|---|---|
| Example: chose mock over real DB for tests | avoids adding mongodb-memory-server devDep |

## Tech debt added

1. <issue> — <where> — <suggested fix and when>

## For the next phase

- Anything the guide should know
- Files or APIs the next phase will need to use
- Decisions made here that constrain future work

## Handoff to next phases

Mandatory for a phase report (fix reports may omit it) — 3-5 short bullets, parsed deterministically (no LLM) into `.guide/phase-ledger.jsonl` and injected into later phases' prompts. Durable decisions, API/schema shapes, and gotchas only — skip phase-specific trivia.

- <bullet>
- <bullet>
- <bullet>

## Issues / blockers (if PARTIAL or FAILED)

- What couldn't be completed and why
- What manual intervention is needed
