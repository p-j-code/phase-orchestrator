# When to Use What: Brief vs Requirements vs Roadmap

Three distinct surfaces that often confuse new users. They're not interchangeable — each one answers a different question at a different point in a project's life.

---

## One-line summary

| Surface | Question it answers | Owned by |
|---|---|---|
| **Requirements** | "What did I just think of?" | You (the operator) |
| **Brief** | "What exactly are we building?" | Guide agent (written from your raw input) |
| **Roadmap** | "What should we build *next*?" | Guide agent (written from completed work) |

---

## Quick decision: where does my input go?

```
You have an idea or feature request
          ↓
Is this for a project that hasn't started yet?
  YES → write it in .guide/raw-thoughts.md, then run `brief`
  NO  →
          ↓
        Is the project still being built?
          YES → /req <project> <text>  (requirements inbox)
          NO  →
                  ↓
                Is the project shipped / substantially complete?
                  YES → /run <project> roadmap
                        (model reads what's done and suggests what's next)
```

---

## Requirements

**Use when:** you have a thought, a bug report, or a feature request and want to capture it without interrupting a running build.

**What it is:** a Telegram/CLI inbox backed by SQLite. Items are lightweight rows — just text, priority, and scope. They're not fed to any agent until you promote them.

**When NOT to use it:**
- Don't use it as a substitute for the brief. Requirements become brief input — they're not the spec themselves.
- Don't promote items directly to a build-in-progress. Promoting mid-build inserts scope into `raw-thoughts.md`; the current plan won't pick it up until a `brief` + `guide` re-run.

**Lifecycle:**
```
/req <project> "Some idea"       ← capture
/triage <project>                ← set priority + scope (now/next/later)
/req_promote <project> --plan    ← flush scope=now items → raw-thoughts.md
                                    and queue brief + guide
```

**Detail:** [FLOW_REQUIREMENTS.md](FLOW_REQUIREMENTS.md)

---

## Brief

**Use when:** you're ready to turn raw ideas into a structured specification that the orchestrator will plan and build from.

**What it is:** `.guide/brief.md` — the canonical document the guide agent reads to produce `plan.json`. It has structure: Goal, Context, Functional requirements, Non-functional requirements, Out of scope, Definition of done.

**When NOT to use it:**
- Don't hand-write a brief from scratch if you have more than a paragraph of ideas — that's what `raw-thoughts.md` + `npm run brief` is for. The guide agent structures it better than manual editing.
- Don't re-author a brief while a build is running. The plan is already generated from the previous brief; mid-run brief changes won't take effect until a plan reset.
- Don't use it for post-ship ideas. That's the roadmap's job.

**When to re-run brief:**
- New requirements were promoted into `raw-thoughts.md`
- You changed your mind about scope
- Brief questions were answered and you want a better draft

**Lifecycle:**
```
# Greenfield:
npm run new -- <project>
# Edit projects/<project>/.guide/raw-thoughts.md with ideas
npm run brief -- <project>           ← guide writes brief.md
# Read .guide/brief.md and .guide/brief-questions.md
# Address questions → re-run brief (cheap: ~$0.02-0.05 per run)
npm run go -- <project>              ← now safe to build
```

**Detail:** [AUDIT_BRIEF_ROADMAP.md](AUDIT_BRIEF_ROADMAP.md#1-brief-mode)

---

## Roadmap

**Use when:** a project is shipped (or substantially complete) and you want the model to suggest what to build next, informed by what was actually built.

**What it is:** `.guide/roadmaps/roadmap-<timestamp>.md` — a document the guide agent writes by reading the completed plan, brief, phase reports, and review notes. It surfaces natural follow-ons, deferred scope, and tech-debt items with size + priority estimates.

**When NOT to use it:**
- Don't run it on a project that hasn't been built yet — there's nothing to extrapolate from. Run `brief` + `guide` first.
- Don't treat its suggestions as a commitment. It surfaces options; you decide which (if any) to act on.
- Don't use it to plan the *current* project. That's the brief's job.

**Two ways to act on roadmap output:**

| Suggestion type | Command |
|---|---|
| "Build a whole new thing" | `npm run roadmap-accept -- <project> --item N --new-project <new-name>` |
| "Add a feature to this or another project" | `npm run roadmap-accept -- <project> --item N --to-inbox <target>` |

Both routes land you back in a known flow — new project lifecycle, or requirements inbox.

**Lifecycle:**
```
npm run roadmap -- <project>         ← guide writes roadmap doc
# Read: npm run preview -- <project> roadmap
# Pick item 2:
npm run roadmap-accept -- <project> --item 2 --new-project <new-project>
# Or append to existing inbox:
npm run roadmap-accept -- <project> --item 2 --to-inbox <same-project>
```

**Detail:** [AUDIT_BRIEF_ROADMAP.md](AUDIT_BRIEF_ROADMAP.md#3-roadmap-mode) · [FLOW_ROADMAP.md](FLOW_ROADMAP.md)

---

## How they connect

```
┌─────────────────────────────────────────────────────┐
│                   YOU (operator)                     │
│                                                      │
│  captures ideas → Requirements inbox (SQLite)        │
│                      ↓ /req_promote                  │
│               raw-thoughts.md                        │
│                      ↓ npm run brief                 │
│  ┌────────────────────────────────────────────────┐  │
│  │  GUIDE AGENT writes .guide/brief.md            │  │
│  │  (structured spec — Goal / Reqs / Out-of-scope)│  │
│  └───────────────────┬────────────────────────────┘  │
│                      ↓ npm run go                    │
│  ┌────────────────────────────────────────────────┐  │
│  │  GUIDE AGENT writes plan.json                  │  │
│  │  DEV AGENTS execute phase-01, phase-02 …       │  │
│  └───────────────────┬────────────────────────────┘  │
│                      ↓ phases complete               │
│  ┌────────────────────────────────────────────────┐  │
│  │  GUIDE AGENT writes roadmap-<ts>.md            │  │
│  │  (what to build next, with scope + priority)   │  │
│  └───────────────────┬────────────────────────────┘  │
│                      ↓ roadmap-accept                │
│         new project OR inbox items                   │
│              (loop restarts)                         │
└─────────────────────────────────────────────────────┘
```

---

## Common mistakes

**"I'll write a long brief by hand."**
Don't. Write bullet points in `raw-thoughts.md` and let the guide agent structure them. Manual briefs miss the `brief-questions.md` step, which is where the model flags gaps before you've wasted a build on them.

**"I'll use /req to add features mid-build."**
Capturing is fine — the inbox is safe to write to at any time. But don't promote mid-build. Promoted items land in `raw-thoughts.md`; they're invisible to the running plan. Promote after the current run finishes and before re-running `brief` + `guide`.

**"The roadmap has good ideas — I'll edit plan.json directly."**
Never edit `plan.json` by hand for new scope. Route through `roadmap-accept --to-inbox`, then `req_promote --plan`, which re-runs `brief` + `guide` so the plan is generated correctly from a coherent spec.

**"I ran roadmap before the project was built."**
Roadmap needs completed phases to extrapolate from. On an empty or early-stage project it produces generic suggestions. Run it after most phases are done.
