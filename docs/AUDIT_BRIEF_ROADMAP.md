# Brief, Audit, Roadmap — v0.4 Modes

Three new modes close the loop: **before, after-build, after-ship**.

```
ROUGH IDEA
   ↓
[brief mode] ← iterate ─┐
   ↓                     │
brief.md ────────────────┘
   ↓
[go] → plan → phases → reviews → ready-for-qa
   ↓
[audit mode] → bug-list draft
   ↓
You edit → bugs-round-N.md
   ↓
[go] → fix phases → ready-for-qa
   ↓
qa --shipped
   ↓
[roadmap mode] → next-project suggestions
   ↓
[roadmap-accept] → new project with seed brief
   ↓
(loop back)
```

## 1. Brief mode

**Goal:** turn rough ideas into a structured brief before plan generation.

```bash
# Greenfield project:
npm run new -- billflow-recurring
# Edit projects/billflow-recurring/.guide/raw-thoughts.md with rough ideas
npm run brief -- billflow-recurring
# Read .guide/brief.md (the draft) and .guide/brief-questions.md (clarifications needed)
# Edit raw-thoughts.md to address questions
npm run brief -- billflow-recurring   # iterate
# When happy:
npm run go -- billflow-recurring
```

**Iterative.** Each call costs 1 Sonnet call (~$0.02-0.05 equivalent). Re-run as you refine. Way cheaper than getting partway into planning and realizing the spec was wrong.

**What it produces:**
- `.guide/brief.md` — structured: Goal, Context, Functional reqs, Non-functional reqs, Conventions, Out of scope, Definition of done
- `.guide/brief-questions.md` — specific questions referencing where answers would change the brief

**Honest about gaps:** if raw-thoughts is vague, the brief author won't invent requirements. Sections you couldn't fill are marked `[NEEDS USER INPUT — see brief-questions.md]`.

## 2. Audit mode

**Goal:** catch bugs after build, before manual QA.

```bash
# After all phases complete (status = ready-for-qa):
npm run audit -- billflow-tds
# Read .guide/audits/audit-<timestamp>.md
# Copy real findings into projects/billflow-tds/.guide/bug-rounds/round-1/bugs.md
# Edit/refine — remove false positives, adjust severity
npm run bugs -- billflow-tds
npm run go -- billflow-tds   # executes fixes
```

**Audit is different from review:**
- **Review** (existing, every 3 phases): "did the dev deliver what the prompt asked?" — fidelity check
- **Audit** (new, post-build): "is this code actually correct?" — correctness check

**Categorizes findings:** CRITICAL / MAJOR / MINOR / DEFERRED-OK.

**Manual promotion:** audit produces a *draft*. You filter for real issues, then commit budget on fixes. Auto-promotion would be dangerous (false positives → wasted fix phases).

**Cost:** 1 Opus call with heavy context (~$0.30-0.60 equiv). High value — catches things manual QA misses, especially items deferred during the build (the "carried tech debt" reviewers flagged but never fixed).

**End of audit includes:**
- Top-3 recommendations
- "What I couldn't verify" section (honest about external dependencies, e.g., NSDL validator)
- "Promote to bugs-round-N" section with copy-paste-ready bug entries

## 3. Roadmap mode

**Goal:** suggest what to build next, with prioritization and dependency awareness.

```bash
# After current project is shipped:
npm run roadmap -- billflow-tds
# Read .guide/roadmaps/roadmap-<timestamp>.md
# Pick a suggestion. Then:
npm run roadmap-accept -- billflow-tds --item 3 --new-project billflow-form-24q
# New project created with raw-thoughts.md seeded from the roadmap item
# Continue the normal flow:
npm run brief -- billflow-form-24q
npm run go -- billflow-form-24q
```

**Sources its suggestions from:**
- Brief's "Out of scope" section (natural follow-ups)
- Phase reports' "For the next phase" notes
- Reviews' "Tech debt" sections
- Bug-rounds plans (what bugs surfaced may suggest preventive features)

**Each suggestion includes:**
- Title + paragraph description
- Scope: S (1-2 phases) / M (3-5) / L (6-9) / XL (multi-module)
- Priority: high/med/low with one-line rationale
- Dependencies: what must ship first
- Risks: what makes this harder than it looks

**Ordered:** high priority first, then medium, then low. Within priority, least-dependency first (so you can start something immediately).

**Cost:** 1 Opus call. Once per phase of the project lifecycle is usually enough.

## Workflow integration

The three modes plug into the existing flow without changing it:

| Stage | Existing command | New command |
|-------|------------------|-------------|
| Pre-plan | (none — write brief manually) | `npm run brief` |
| Plan | `npm run go` | — |
| Build | `npm run go` | — |
| Review | (in `go`) | — |
| Post-build | (start bugs round manually) | `npm run audit` |
| Bug fixes | `npm run bugs` + `npm run go` | — |
| Ship | `npm run qa --shipped` | — |
| Post-ship | (start new project manually) | `npm run roadmap` + `npm run roadmap-accept` |

## Tips

**Audit isn't a substitute for manual QA.** Manual QA catches UX issues, missing requirements, and "this is technically correct but not what I meant." Audit catches code-level correctness issues. Use both.

**Brief iterations are cheap. Use them.** Three iterations on a brief catches scope mistakes that would cost 50+ Sonnet calls to fix downstream.

**Roadmap suggestions are starting points, not commitments.** Use them to surface ideas you forgot. Reject suggestions that don't fit your priorities — the model doesn't know your full context.

**Audit will surface things reviewers already flagged.** That's a feature, not a bug. Reviewers flagged "carried tech debt" item N back at phase 4 — if it's still open at audit time, the audit will re-surface it. Use that signal.
