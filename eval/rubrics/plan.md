# Rubric — `plan` guide task

CHECKLIST for grading a `plan.json` produced by the `plan` guide task against its
brief. Each item below is scored **independently pass/fail** by the
`prompt-eval-judge` call. The case score is the **fraction of items passed**
(checklist scoring, not one scalar) — this damps single-judgment noise.

Score each item strictly against what the artifact actually contains. When in
doubt, fail the item.

- [ ] The artifact is valid JSON with a top-level `phases` array containing at least two phases.
- [ ] Every phase has a non-empty `title` and a non-empty `goal`.
- [ ] Every phase has an `acceptance_criteria` array with at least one concrete, testable criterion.
- [ ] Phase numbers (`n`) are strictly increasing with no gaps or duplicates.
- [ ] Every phase lists the files it will create or modify (`files_expected`).
- [ ] No phase `depends_on` a phase with a higher number (no forward dependencies).
- [ ] The phases collectively cover every functional requirement (FR) stated in the brief.
- [ ] Each phase is a coherent, self-contained unit of work rather than a grab-bag of unrelated tasks.
- [ ] Acceptance criteria are specific enough to verify against code (they avoid vague wording like "works correctly").
- [ ] The number of phases is proportionate to the brief's scope (neither collapsed into one mega-phase nor over-split into trivial ones).
