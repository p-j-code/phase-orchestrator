# Model Routing

Every Claude call goes through `src/model-router.js`. Decisions are visible, configurable, and reproducible.

## How routing works

Pipeline applied in order. **Steps 3–4 (keyword + complexity escalation) run ONLY for execution tasks** — see "Escalation scope" below.

1. **Baseline** — `config/defaults.json` `models.&lt;task&gt;` (e.g., `dev-execution: sonnet`, `audit-scan: sonnet`)
2. **Phase override** — if `plan.json` has `model_override` on the phase, use that
3. **Keyword rules** — scan phase title/goal/notes/criteria for keywords in `config/model-routing.json`. `force_tier` rules (regulatory-core, security-core) pin opus; `min_tier` rules (regulatory-domain, security-domain) set a floor.
4. **Complexity scoring** — count signals: max_turns, acceptance_criteria count, files count, keyword hits
5. **Hard floors** — e.g., `plan-creation`, `audit`, `roadmap` always opus
6. **Failure-driven escalation (graduated ladder, phase 23)** — a `.guide/&lt;phase|fix&gt;-…-escalate.marker` (JSON `{ target_tier, failed_tier, reason, at }`, written when that phase/fix previously failed) pins the retry **upward** to `target_tier`, cleared on success. `target_tier` is the rung immediately above the tier that failed (sonnet→opus, opus→fable); a fable failure writes no marker and the run pauses. Legacy `*-escalate-opus.marker` files still on disk are read as target opus.

Each step produces a reasoning entry. The full chain is logged before every call.

> **Changed in phase 23 — the graduated escalation ladder.** Escalation was a single opus-then-pause hop, so an opus-baseline failure wasted an identical opus retry and the fable rung was unreachable. Now escalation steps one rung at a time up `TIER_ORDER`, bounded by `auto_run.max_escalation_hops` (default 2, a per-phase/fix per-run budget tracked as a hop count, not a boolean). A hop to **fable** (the priciest rung) is **billing-gated**: it's skipped when `windowStatus(cfg).state` is not `'ok'`, and the run pauses (the marker stays, so a later `/resume` resumes the escalation once the window clears). The single marker writer + read-side resolution live in `src/lib/escalation.js`.

> **Changed in v0.14.36/37 — read if you remember the old pipeline.**
> - **`prefer_top_for_critical` is retired** (set false). High complexity no longer auto-escalates to opus — it was a weak proxy that silently overspent. The replacement is *failure-driven* escalation (step 6): a phase/fix runs opus on retry only after it actually failed on the cheaper model. Flip the key back to `true` to restore the old behavior.
> - **Haiku is fully retired** from routing — removed from tier order, tier models, and fallbacks; the old `tier_caps` / `never_use_haiku_*` knobs are gone. A stray haiku reference clamps to sonnet.

## Escalation scope (v0.14.37)

`config/model-routing.json` has a top-level `escalation_tasks` (default `["dev-execution", "fix-execution"]`). Keyword rules (step 3) and the phase-derived half of complexity scoring (step 4) apply **only** to tasks in this list. Overhead/guide tasks (`phase-prompt-gen`, `fix-prompt-gen`, `3-phase-review`, `bug-plan`, `roadmap`, …) route on their baseline + hard floors alone, with an explicit "phase meta ignored" reasoning line.

Why: `runGuide` passes the project's *next phase* meta into routing for every guide task. Before this gate, a project sitting in front of a phase titled e.g. "FVU generator" had its prompt-gens, reviews, and bug-plans force-tier'd to opus by that phase's *title* — tasks that merely reference the phase, not execute it. That was ~$280/month of misrouting on a live 30-day report.

## Two-stage audit routing (v0.14.36)

A full audit is two calls with two different tasks: `audit-scan` (Sonnet baseline, no opus floor — it over-reports candidates) and `audit` (opus via hard floor — it adjudicates). They appear as separate rows in `/spend`. Incremental re-audits are a single `audit` call. Toggle with `audit.two_stage`.

## Keyword rule types

| Type | Effect | Use case |
|------|--------|----------|
| `force_tier` | sets tier regardless of current | regulatory keywords → always opus |
| `min_tier` | raises tier only | data-correctness → at least sonnet |
| `max_tier` | caps tier only | low-stakes UI → no more than sonnet |

Example:
```json
{
  "label": "regulatory",
  "match": ["FVU", "NSDL", "GSTR", "26Q"],
  "force_tier": "opus",
  "reason": "regulatory correctness — wrong implementation has legal consequences"
}
```

## Default rules (config/model-routing.json)

- **regulatory** (FVU, NSDL, GSTR, 26Q, compliance, GDPR, HIPAA) → opus
- **security-critical** (auth, JWT, OAuth, crypto, PII, RBAC) → opus
- **data-correctness** (migration, schema change, transaction, money) → ≥ sonnet
- **performance-critical** (worker, queue, concurrency, race condition) → ≥ sonnet
- **low-stakes-ui** (styling, copy, label, icon, tooltip) → ≤ sonnet

## Per-project customization

Edit `config/model-routing.json` directly. The rules are global — they apply to every project. If a specific project needs different rules, set `model_routing` overrides in `projects/&lt;name&gt;/project.json`:

```json
{
  "overrides": {
    "model_routing": {
      "user_preferences": {
        "require_confirm_for_opus": true,
        "prefer_top_for_critical": false
      }
    }
  }
}
```

## Disabling routing entirely

```json
{
  "model_routing": { "enabled": false }
}
```

Falls back to static `config/defaults.json` models per task.

## The `analyze` command

```bash
npm run analyze -- billflow-tds
```

Shows the full routing table for every phase in `plan.json`. No Claude calls made. Useful for previewing a project's complexity profile before running it.

Output:
```
Phase  Title                                Complexity   Tier      Model
1      Schema foundation                    medium       sonnet    claude-sonnet-4-6
5      NSDL FVU text generator              critical     opus      claude-opus-4-7   (override)
```

## Tuning tips

**Routing too conservative (always opus):** lower the complexity thresholds in `complexity_thresholds`, or remove broad keywords from `force_tier` lists.

**A guide task (prompt-gen / review / bug-plan) routed to opus unexpectedly:** check whether its task is in `escalation_tasks` — it should NOT be. Only execution tasks escalate on phase keywords/complexity. **Dev/fix on opus (or fable) when you expected sonnet:** look for a `…-escalate.marker` (the task failed a prior attempt — the marker's `target_tier` names the rung it escalated to; a legacy `…-escalate-opus.marker` reads as opus) or a `force_tier` keyword hit (regulatory-core / security-core) in the logged reasoning. **A fable escalation was expected but the run paused instead:** the fable hop is billing-gated — check for `⚠ escalation to fable skipped — billing window state '<state>'`; the retry resumes on the next `/resume` once the window is `ok`.

**Specific project needs custom rules:** override in project.json (see above).

**Debug a specific phase's routing:** run `npm run analyze -- &lt;project&gt;` to see the table, or scan terminal logs during auto-run (every call shows reasoning).
