# Prompt-eval harness (`eval/`)

Phase 84 (brief 05 P6). A regression harness for the orchestrator's own guide
**prompts** — it catches "we edited a prompt / the model router / the
phase-runner prompt builders and quietly made plans worse" before it ships.

Run it:

```bash
npm run eval:prompts            # auto-select cases from the git diff
npm run eval:prompts -- --task plan
npm run eval:prompts -- --help
npm run eval:prompts -- --update-baseline   # record current scores as the reference
```

## How it works

1. **Billing-guard gate.** The harness refuses to start when the billing window
   is `warn` or `pause` (naming `billing.warn_at_calls` / `billing.pause_at_calls`
   as the source). Every case makes real haiku/sonnet calls, so it must not run
   when the window is under pressure. It reads the **production** window through a
   separate read-only DB connection.
2. **Isolation.** It copies a frozen fixture into a throwaway project and points
   `process.env.DB_PATH` at a temp SQLite DB **before** importing state, so
   fixture projects and their calls never touch the production DB. The scratch
   dir is removed when the run finishes.
3. **Real prompt assembly.** It registers the fixture project in the isolated DB
   and runs the selected guide task through the **real** `runGuide` /
   phase-runner prompt assembly — real model calls, which is the entire point.
4. **Validation.** The produced `plan.json` is checked structurally with
   `validatePlanStructure` (the same validator the P1 llm-contract uses for
   plan.json) plus an advisory AJV pass against `config/schemas/plan.schema.json`.
5. **Checklist judge.** One roleless `prompt-eval-judge` call (task
   `prompt-eval-judge`, `models['prompt-eval-judge']`) grades the artifact against
   the task's rubric (`eval/rubrics/<task>.md`). Each rubric item is scored
   independently pass/fail; the case score is the **fraction of items passed** —
   checklist scoring, not one scalar, to damp judge noise. The call is wrapped in
   the P1 llm-contract (tolerant parse + AJV schema + one re-ask).
6. **Baseline compare.** The score is compared to `eval/baselines.json`. A drop
   beyond `eval.tolerance` (default 0.1) exits **non-zero**. A case with no
   established baseline (`score: null`) is reported but never gates.

## Fixtures (frozen)

- `fixtures/cli-tool/` — a 3-phase-scope CLI brief (`tod18` task tracker).
- `fixtures/tiny-api/` — a 2-phase-scope API brief (`linkstash` URL shortener).

Each carries `inputs/brief.md` plus the minimal `.guide/` layout (a `.guide/brief.md`
the plan task reads). **Do not edit fixtures** — baselines depend on byte-stability.

> A third **Vue** fixture (a component/render case) is **deferred** until this
> harness proves itself on the two text-artifact fixtures above. Add it, its
> rubric, and its baseline entry once the plan-task loop is trusted.

## Baselines

`baselines.json` holds one entry per `<fixture>/<task>` case: `score`,
`artifact_hash`, `model`, `date`. Establish them with `--update-baseline` on a
trusted checkout. Any non-case keys (like `_comment`) are preserved on update.

## Testing

Real-call evals **never** run under `npm test`. The harness (`scripts/eval-prompts.mjs`)
exports `runEval(opts, deps)` where every LLM/DB interaction is an injectable
seam; the test suite (`src/eval-prompts.test.mjs`) drives it with fakes only —
no real calls, no production DB. The P7 autopilot schedules real evals as a
CHEAP `eval` job into leftover window headroom (see `src/server/job-runner.js`).
