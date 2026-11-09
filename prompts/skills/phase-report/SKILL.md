---
name: phase-report
description: Exact completion-report format and path, and the working-directory rules for what you may write to.
---

6. Write a completion report to the EXACT path specified in the prompt header (look for "Report path:" or "Report file:" — the guide always provides it). The path is relative to your working directory. The standard locations are:
   - Phases: `../.guide/phases/NN-<slug>/report.md` (e.g., `../.guide/phases/05-fvu-file-builder/report.md`)
   - Fixes:  `../.guide/bug-rounds/round-R/fixes/NN-<slug>/report.md` (e.g., `../.guide/bug-rounds/round-4/fixes/13-upload-security/report.md`)
   - If the prompt header doesn't specify a path, search for the existing folder under `../.guide/phases/` or `../.guide/bug-rounds/round-R/fixes/` matching your phase/fix number prefix (e.g., `01-`, `02-`, `13-`). The orchestrator created it for you.

The completion report contains:
- Files changed (created/modified/deleted)
- Decisions made (and why)
- Anything the guide should know for the next phase/fix
- Any acceptance criteria you couldn't meet and why
- **An "Acceptance criteria self-assessment" table** — mandatory, one row per acceptance criterion: `| Criterion | Status (done/partial/uncertain) | Evidence (file:line) | Confidence (high/med/low) |`. Fill this in AFTER running `git diff` and re-reading each criterion, not from memory — the orchestrator parses it to focus its own acceptance checker on whatever you flagged as uncertain. See the work protocol's self-verify step and the phase-report-template.md for the exact column format.
- **A "## Handoff to next phases" section** — mandatory for a PHASE report (fix reports may omit it). 3-5 short bullet points capturing what a LATER phase, running in a fresh session with no memory of this one, needs to know: durable decisions made here, API/schema shapes you introduced, and gotchas. Skip phase-specific trivia — only things that bind future work. Format as a plain bullet list (`- ` or `* ` lines) directly under the heading, e.g.:

  ```
  ## Handoff to next phases

  - New `POST /api/invoices/:id/void` endpoint — payload is `{reason: string}`, 400 on already-voided
  - `InvoiceStatus` enum now has a `VOIDED` value; any switch/case over it elsewhere must add a case
  - Void reason strings are capped at 500 chars server-side — do not raise this without a migration
  ```

  This is read deterministically (no LLM) by the orchestrator into `.guide/phase-ledger.jsonl` and injected into later phases' prompts — a missing or unparseable section is fail-open (best-effort fallback, or the phase simply gets no ledger entry) and never fails your phase, but a real 3-5 bullet list here is what makes the next phase's dev agent actually see it.

# Working directory rules

- You write code ONLY to `workspace/`.
- You write the completion report ONLY to the specified `../.guide/phases/NN-<slug>/report.md` or `../.guide/bug-rounds/round-R/fixes/NN-<slug>/report.md` path (one level up from workspace, into the project's .guide/ folder).
- You NEVER write to legacy flat paths like `.guide/phase-N-report.md` or to `.guide/` inside workspace — those are wrong. The orchestrator reads from `../.guide/` only.
- You NEVER touch `.guide/plan.json`, `.guide/fix-plan-round-*.json`, prompt files, or any other guide files.
- You NEVER touch `inputs/` or `outputs/`.
- Run `git` only inside `workspace/`.
- **Commit all generated lockfiles** (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, etc.) by default unless the prompt explicitly says otherwise. Lockfiles are part of reproducible builds.
