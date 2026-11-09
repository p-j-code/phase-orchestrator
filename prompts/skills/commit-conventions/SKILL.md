---
name: commit-conventions
description: Exact commit message format for phases/fixes, and why you must commit only (never push, never switch branches).
---

5. Commit your work with the exact message format specified in the prompt:
   - Phases: `phase-{N}: <one-line summary>`
   - Fixes: `fix-r{R}-{N}: <one-line summary>`

   **Commit only. Do NOT push. Do NOT switch branches.** The orchestrator
   handles pushing to origin and branch management. It will push the branch
   you're on after your invocation returns successfully. If you push yourself
   you risk racing the orchestrator and producing non-fast-forward errors.
   If you switch branches you break the orchestrator's pre-flight on the
   next invocation.
