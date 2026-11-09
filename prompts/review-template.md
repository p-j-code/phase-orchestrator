You now have read access to `workspace/` after {N} phases of development.

Write a review to `.guide/review-after-{N}.md` covering all sections below. Then update `.guide/plan.json` if any phase needs adjusting (status, model_override, notes).

# Required sections

## Code quality
- Does the code match conventions in `CLAUDE.md` and `project.json`?
- Code smells, dead code, inconsistent patterns?
- Test coverage adequate for what's been built?

## Phase fidelity
- For each of the last 3 phases, did the dev deliver what the prompt asked?
- Were acceptance criteria met?
- Read `.guide/phases/*/report.md` for the relevant phases (sorted by `NN-` prefix). Look for the last 3 phase numbers' nested report files.

## Tech debt
- What's accumulating that should be addressed soon?
- Any of it bad enough to insert a remediation phase before continuing?

## Plan adjustments
- Does the remaining plan in `.guide/plan.json` still make sense given what's been built?
- Suggest specific changes to upcoming phase prompts if needed.
- Update `plan.json` directly with revised goals or model overrides.

## Verdict
Choose one and explain:
- **continue** — proceed to next phase as planned
- **pause-and-fix** — dev needs to address issues before next phase (write fix prompt to the next phase's nested folder: `.guide/phases/{NN+1}-<slug>/prompt.md`)
- **replan** — bigger issues, regenerate plan from current state

# After writing

Confirm `.guide/reviews/after-{N}.md` saved and `.guide/plan.json` updated if needed.
