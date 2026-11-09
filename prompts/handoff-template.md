Your context has grown large. You are about to be replaced by a fresh guide agent.

Write a handoff document to `.guide/handoff.md`. The next guide instance has zero context — this document is its only seed. Be thorough.

# Required sections

## Project state
- Name, tech stack, current phase number, total phases planned
- High-level summary of what the project is

## Completed phases
For each completed phase:
- Phase number
- One-line summary of what was built
- Key files affected
- Any known debt or issues

## Remaining phases
Full remaining plan. For each:
- Phase number
- Goal
- Acceptance criteria
- Any model overrides or special notes

## Key decisions made
- Architectural choices and why
- Library picks and why
- Conventions established
- Anything non-obvious

## Pitfalls discovered
- Bugs hit
- Things that took longer than expected
- Gotchas the next guide should know to avoid

## Current status
- What just happened in the last few turns
- What should happen next (e.g., "generate phase-{N}-prompt next")

# Also write: `.guide/qa-journeys.json`

In the SAME handoff task, additionally write `.guide/qa-journeys.json` — the QA journeys a runtime-QA agent will walk once the build is done. Derive them from the brief's **Definition of done**.

Format — a JSON array (valid JSON only: no comments, no trailing commas):

```json
[
  { "name": "<short journey name>", "steps": ["<observable step>", "<observable step>"] }
]
```

Each journey is one concrete, user-facing path the agent can exercise by launching the app and probing it (curl/HTTP for a server or API, direct CLI invocation for a CLI — no browser automation). Keep every step observable: a command to run, an endpoint to hit, an output or exit code to check. If the brief has no Definition-of-done section, write `[]`.

# After writing

Confirm `.guide/handoff.md` is saved. The orchestrator will read it and seed a fresh guide session with its contents.
