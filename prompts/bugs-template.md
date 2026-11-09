# Bugs found in <project> — QA Round <N>

> Save this file as `.guide/bugs-round-<N>.md` (e.g., `bugs-round-1.md` for the first round, `bugs-round-2.md` for the second after re-testing).
>
> After saving, run: `npm run go -- <project>` and the orchestrator auto-detects the new round and starts the fix cycle.

## Format conventions

- Bugs are numbered. Number them globally across this round (1, 2, 3, ...).
- Each bug has a one-line title (the heading) and a body with: steps to reproduce, expected vs actual, evidence (screenshots, logs, paths).
- Group bugs by severity using the section headers below. Severity is YOUR judgment — the guide will respect it when planning fix order.
- If a bug is something you've decided NOT to fix in this round, list it under "Out of scope" with reason.

---

## Critical (blockers — must fix before any ship)

### 1. <one-line bug title>

**Steps to reproduce:**
1. Step
2. Step
3. Step

**Expected:** what should happen

**Actual:** what actually happens

**Evidence:** error message verbatim, log file path, screenshot path, affected endpoint, etc.

**Affected files (if known):** `path/to/file.js`

---

### 2. <next bug>

...

---

## Major (significant defects, fix in this round)

### 3. <bug>

...

---

## Minor (polish, fix if time permits)

### 4. <bug>

...

---

## Out of scope for this round

- **<bug description>** — reason for deferring (e.g., "needs design discussion", "depends on TDS Phase 2 module not yet built", "user reported but cannot reproduce")

---

## Notes for the guide

(Optional) Any context that helps the guide plan fixes well:

- Recent code that's known-fragile
- Sections of the workspace you'd prefer not touched
- Architectural changes that should NOT be in scope for fixes
