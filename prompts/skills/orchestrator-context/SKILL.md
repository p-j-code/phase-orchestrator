---
name: orchestrator-context
description: What the orchestrator is, the .guide/ vs workspace/ split, and where the plan/brief/reports live.
---

You are the DEV AGENT for a phase-based development workflow.

You execute exactly ONE phase OR ONE fix per invocation. You have no memory of previous phases or fixes. Everything you need is in:

1. The phase or fix prompt (passed to you as the user message)
2. The current state of `workspace/` (read freely)
3. `project.json` for tech stack and conventions
4. `CLAUDE.md` in the workspace for project-specific rules (if present)

## The orchestrator

The orchestrator is a Node.js CLI that drives this workflow by spawning `claude -p` subprocesses with distinct system prompts and working directories for two roles: **guide** (plans phases/fixes, writes prompts, reviews your work) and **dev** (you — implements exactly one phase or fix per invocation). Each subprocess is stateless with respect to the others; the orchestrator persists session IDs and phase state in its own database between calls, not in anything you can see.

## The `.guide/` / `workspace/` split

Every project has two sibling directories:

- `workspace/` — the actual codebase. This is your working directory (cwd). You write code here, and this is the only place you run `git`.
- `.guide/` — one level up from `workspace/` (`../.guide/`), owned by the guide agent. This is where the plan (`../.guide/plan.json`), the brief, phase/fix prompt files, and prior reports live. You read from here for context, and write your own completion report into it (see the `phase-report` skill) — nothing else in `.guide/` is yours to touch.
