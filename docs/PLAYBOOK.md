# Playbook

How to use the orchestrator for each of the six things you'll actually do.
Read this once and you'll know what to type and what to tap for any
real-world task.

Each scenario is written as a walkthrough: **what you type → what the bot
says → what you do next**. If you forget what step you're on, send
`/coach &lt;project&gt;` (or just `/coach` if you've pinned one) and the bot
will tell you literally "do this next."

---

## 🧭 Cheat sheet: "what should I do right now?"

If you're not sure what state your project is in or what the next move
is, this table maps every common situation to one command. It's the
static version of what `/coach` returns dynamically — when in doubt,
just send `/coach` from your phone and skip the table.

| If your project looks like… | Most likely next step | Command (or button) |
|---|---|---|
| Fresh project, nothing captured yet | Capture some ideas | `/req &lt;project&gt; "…"` or `/capture &lt;project&gt;` for many |
| Inbox has many pending items | Triage them | `/triage &lt;project&gt;` |
| Inbox has a few items, ready | Promote + auto-plan | `/req_promote &lt;project&gt; --plan` |
| `raw-thoughts.md` exists, no brief | Generate brief | `/run &lt;project&gt; brief` |
| `brief.md` exists, no plan | Generate plan | `/run &lt;project&gt; guide` |
| `plan.json` exists, all phases pending | Sanity-check cost, then go | `/predict &lt;project&gt;` then ▶ Start auto-run |
| Some phases done, some pending | Continue auto-run | `/run &lt;project&gt; go` (idempotent) |
| Auto-run paused (review checkpoint) | Resume after reading review | ⏯ Resume button (or `/run &lt;project&gt; resume`) |
| Auto-run paused (validator failure) | Retry phase or hand-fix | 🛠 Retry button (or `/retry &lt;project&gt; &lt;phase&gt;`) |
| All phases done, no audit yet | Audit before ship | `/run &lt;project&gt; audit` |
| Audit done, findings not promoted | Read first, then promote | 📖 Read audit, then 📤 Promote button |
| Critical bug(s) in inbox | Promote criticals to fix round | `/bug_promote &lt;project&gt; --critical` |
| Any pending bugs in inbox | Promote all to fix round | `/bug_promote &lt;project&gt;` |
| Bug round in progress, not run | Run the fix round | `/run &lt;project&gt; bugs` |
| `develop` is ahead of `main` | Ship | `/ship &lt;project&gt;` |
| Project is fully built + shipped | Generate QA handoff | `/qa_handoff &lt;project&gt;` |

**Stuck or confused?** Send `/coach` (or `/coach &lt;project&gt;`). The bot
will look at the live state and tell you exactly what to tap next.

---

## Scenario 1: I have an idea, take it to working code

> **The flow:** capture the idea → polish it into a brief → generate a plan
> → run the plan.

### Step 1. Tell the bot what you want

```
You: /req myproject "Add a dark mode toggle to the settings page"
Bot: ✓ Saved to inbox (#42).
     Pinned: myproject
     Next: /triage myproject when you have a few items
```

You can keep adding more ideas:

```
You: /req myproject "Remember the toggle state across sessions"
You: /req myproject "Default to system preference"
```

Or for a long brain-dump, use multi-message mode:

```
You: /capture myproject
Bot: 📝 Capture mode on. Send any text. /done when finished.
You: Make settings page mobile responsive
You: Move account menu to top right
You: /done
Bot: ✓ Captured 2 items.
```

### Step 2. Sort what matters

When you've captured a few items, decide which are urgent:

```
You: /triage myproject
Bot: shows your first inbox item with buttons:
     [p0] [p1] [p2] [p3]   ← priority
     [now] [next] [later] [no]   ← when
     [skip] [drop] [done]
```

Tap one priority button + one scope button, the bot auto-advances to the
next item. Takes ~30 seconds for 10 items.

### Step 3. Promote to the actual project

```
You: /req_promote myproject --plan
Bot: 📝 Promoted 7 requirement(s)
        project: myproject
        file: projects/myproject/.guide/raw-thoughts.md
     IDs: #1, #2, #3, #4, #5, #6, #7

     ▶ Plan mode active.
     
     Here's exactly what happens next:
       1️⃣  brief job runs (~30s)
       2️⃣  guide job runs (~2-5 min)
       3️⃣  I DM you when guide finishes, with buttons to:
            • ▶ Start auto-run
            • 📖 Read plan
            • 💰 Predict cost
     
     No code is written until you tap ▶ Start auto-run.
     
     Want only some next time? Run /triage myproject before
     promoting — only scope=now items get included.
```

If you captured into one project and want to send the items to a
different one, pass both names:

```
You: /req_promote _inbox myproject --plan
```

(That's the same command — when source and destination are different,
the bot shows "from X into Y" instead of "project: X".)

The `--plan` flag is the magic: it auto-runs `brief` then `guide` so by
the time you check back you have a plan ready to review. It stops there
— you eyeball the plan before any code gets written.

### Step 4. Review the plan

```
Bot DMs you when the guide job finishes:
     ✓ Completed: guide myproject
     [📖 Read plan] [▶ Start auto-run] [💰 Predict cost]

You: tap "📖 Read plan"
Bot: shows the plan.md, paginated
```

If the plan looks right, tap **▶ Start auto-run**. If not, edit
`brief.md` on the Mac and re-run `/run myproject guide`.

### Step 5. Let it cook

```
You: tap "▶ Start auto-run"
Bot: ✓ Queued: go myproject (job #45)
     ▶ Starting: go myproject

(later)
Bot: ⏸ Paused at phase 1 — review checkpoint
     [📖 Read review] [⏯ Resume] [✗ Cancel]
```

The bot pauses on its own at design checkpoints (after phase 1, every N
phases, after validator failures). At each pause you decide whether to
keep going.

```
You: tap "⏯ Resume"
... cycle repeats until all phases complete ...
Bot: ✓ Completed: go myproject — 8 phases, 23 commits
     [🔍 Audit] [📋 QA handoff] [🚢 Ship to main]
```

### Step 6. Ship it

```
You: tap "🚢 Ship to main"
Bot: 🚢 Ship myproject: develop → main?
     [Yes, ship] [No]
You: Yes, ship
Bot: ✅ Shipped myproject (a1b2c3d → e5f6g7h)
```

Done. Total commands typed: 5–6. Everything else was taps.

---

## Scenario 2: Something's broken, fix it

> **The flow:** capture the bug → promote → auto-runs the fix → commits.

### Step 1. Report the bug

```
You: /bug myproject "critical: login redirects in a loop after timeout"
Bot: 🔴 Bug #51 captured (critical).
     Inbox: 3 critical, 2 major, 0 minor.
     Next: /bug_promote to start fixing.
```

The `critical:` / `major:` / `minor:` prefix sets severity. Without it,
the bug shows up as `unassigned` and you can tap-set severity later in
`/bugs_inbox`.

### Step 2. Promote + auto-fix

```
You: /bug_promote myproject
Bot: ✓ Promoted 5 bugs to round-3.
     ✓ Queued: bugs myproject (job #52)
     ▶ Starting: bugs myproject
```

That's it. The orchestrator reads the bugs, plans fixes, applies them
one-by-one (each as a separate commit), and runs validators after each.

### Variant: only the urgent ones

```
You: /bug_promote myproject --critical
Bot: ✓ Promoted 3 critical bugs to round-3.
     ✓ Queued: bugs myproject (job #52)
```

Major and minor stay in the inbox.

### Step 3. Watch it work

```
Bot: ✓ Fixed BUG-1: login redirect loop (commit a1b2c3d)
Bot: ✓ Fixed BUG-2: session timer race (commit e5f6g7h)
Bot: ⚠ Fix-3 paused: validator failed (eslint)
     [🛠 Retry phase] [📖 Show errors] [✗ Drop bug]
```

If a fix doesn't validate, the bot tells you and offers buttons. If
everything passes:

```
Bot: ✓ Round-3 complete: 5 fixes, 5 commits, all green
     [📖 Read summary] [🚢 Ship to main] [🔍 Audit]
```

### Step 4. Ship

Same as Scenario 1's last step.

---

## Scenario 3: Plan the next big thing (Roadmap)

> **The flow:** generate roadmap → review it → spawn the projects it
> suggests → develop normally from there.
>
> Full technical reference: [`FLOW_ROADMAP.md`](./FLOW_ROADMAP.md).

### Step 1. Ask for a roadmap

```
You: /run myproject roadmap
Bot: ✓ Queued: roadmap myproject (job #61)
     ▶ Starting: roadmap myproject

(later)
Bot: ✓ Completed: roadmap myproject
     [📖 Read roadmap] [📥 Save items to inbox]
```

The roadmap analyses what's in the codebase and suggests "what comes
next" — usually 3–7 follow-on projects or features with rough scoping.

### Step 2. Read it

```
You: tap "📖 Read roadmap"
Bot: shows the roadmap.md (paginated)
```

A roadmap entry looks like:

```
## Project: notifications-v2
- Tech: Node.js worker + Redis stream
- Scope: ~4 phases, ~2 days
- Why: current sync pipeline can't survive 10x volume
- Depends on: nothing
```

### Step 3. Accept the parts you want

The Telegram path right now is: read the roadmap, then for items you
want to actually build, hand-copy them into requirements:

```
You: /req notifications-v2 "Build worker-based notification fan-out"
You: /req notifications-v2 "Add Redis stream durability"
You: /req_promote notifications-v2 notifications-v2 --plan
```

For projects that don't exist yet, register them first:

```
You: /new_project notifications-v2 git@github.com:you/notif-v2.git
Bot: ✓ Registered. Workspace cloned.
You: /req notifications-v2 "..."  (as above)
```

From here you're in Scenario 1.

### CLI shortcut

The CLI has `npm run roadmap-accept -- &lt;project&gt;` that automates the
above for items marked "auto-accept: yes" in the roadmap. Not in
Telegram yet — typing GitHub URLs on mobile is too painful.

---

## Scenario 4: Sweep for problems (Audit)

> **The flow:** run audit → review findings → promote real ones to bug
> round → fix.

### Step 1. Run the audit

```
You: /run myproject audit
Bot: ✓ Queued: audit myproject (job #71)
     ▶ Starting: audit myproject

(15-25 minutes later)
Bot: ✓ Completed: audit myproject
     [📖 Read audit] [📤 Promote findings] [🗺 Generate roadmap]
```

The audit is read-only. It never edits code. It produces a markdown
document with findings ranked CRITICAL / MAJOR / MINOR / NIT.

### Step 2. Read the findings

```
You: tap "📖 Read audit"
Bot: shows the audit.md (paginated). Look for the CRITICAL / MAJOR
     sections. Skip NITs unless you're feeling thorough.
```

Audits average a 20–30% false-positive rate. Don't take every finding
at face value.

### Step 3. Promote what's real

```
You: tap "📤 Promote findings"
Bot: 📤 Promote audit for myproject?
     Source: audit-2026-05-25T10-30Z.md
     Target: bug-rounds/round-4/bugs.md
     ⚠ Review the file on the Mac to strip false positives before
       /run bugs.
     [Yes — promote to round 4] [Cancel]
You: Yes
Bot: ✓ Promoted audit for myproject → bug-rounds/round-4/bugs.md
     Next: review on the Mac, strip false positives, then /run bugs.
```

### Step 4. Review on the Mac (important!)

```
$ code projects/myproject/bug-rounds/round-4/bugs.md
```

Read every BUG-N. Delete the ones that aren't real. The 10 minutes you
spend here saves the orchestrator from burning budget on bogus fixes.

### Step 5. Run the fix round

```
You: /run myproject bugs
Bot: ✓ Queued: bugs myproject (job #72)
```

You're now in Scenario 2 from step 3 onwards.

---

## Scenario 5: Watch git, ship to main

> **The flow:** verify the state of develop → fast-forward main → tag if
> wanted.

### Anytime — check what's on develop

```
You: /git_status myproject
Bot: 📊 myproject:
     develop @ a1b2c3d (8 ahead of main)
     main    @ b9c8d7e
     working tree: clean
```

That "8 ahead of main" is what shipping will merge. Tap-read the commits
if you want detail:

```
You: /preview myproject git
Bot: Last 10 commits on develop:
     a1b2c3d feat: dark mode toggle (just now)
     ... (paginated)
```

### Pull updates from origin (rarely needed)

If you have another machine pushing to origin and want this clone in
sync:

```
You: /sync myproject
Bot: 🔄 Syncing myproject…
     ✓ Fast-forwarded develop: 3 commits behind → up to date
```

If origin and your workspace have diverged (someone else committed
weird stuff), `/sync` refuses and tells you. Resolve on the Mac.

### Ship to main

```
You: /ship myproject
Bot: 🚢 Ship myproject: develop → main?
     Tag: (none — pass --tag vX.Y.Z to set)
     [Yes, ship] [No]
You: Yes
Bot: ✅ Shipped myproject
     a1b2c3d → b9c8d7e (8 commits)
```

### Ship + tag in one go

```
You: /ship myproject --tag v0.2.0
Bot: 🚢 Ship myproject: develop → main?
     Tag: v0.2.0
     [Yes, ship] [No]
```

That's it. Ship is fast-forward only — it refuses if main has commits
not on develop. If that happens (you pushed a hotfix to main from
elsewhere), resolve on the Mac with a normal merge or rebase.

---

## Scenario 6: Hand off to a tester (QA handoff)

> **The flow:** run the generator → DM the markdown to your tester → they
> have what they need.

### Generate the doc

```
You: /qa_handoff myproject
Bot: 📋 Generating QA handoff for myproject…
     (a few seconds)
Bot: [sends you a .md file attachment]
     "QA handoff — myproject"
```

The doc lists:
- Every commit since the last QA handoff (or since project start)
- Behaviour changes, grouped by area
- Suggested test cases per behaviour change
- Known-broken / known-not-tested areas

### Forward to the tester

Telegram → forward → tester. Or save and email it. The doc is
standalone — your tester doesn't need orchestrator access.

### After QA finds bugs

When the tester comes back with bug reports:

```
You: /bug myproject "major: dark mode flickers on Safari iOS 15"
You: /bug myproject "critical: settings page doesn't save on submit"
You: /bug_promote myproject
```

You're now in Scenario 2.

### Variant: include test steps

```
You: /qa_handoff myproject --with-steps
```

Generates a more thorough doc that includes step-by-step repro steps
for each behaviour change. Helpful for testers who don't know the
codebase.

---

## Cheat sheet: "what do I type next?"

If you forget where you are, just send:

```
You: /coach
```

(If you have a pinned project. Otherwise `/coach &lt;project&gt;`.)

The bot looks at the project state and tells you literally what to do:

```
Bot: 📍 myproject is paused at phase 3 with a validator failure.
     
     Most likely next step:
     [🛠 Retry phase 3]
     
     Other options:
     [📖 Read the error] [✗ Drop this phase]
```

You don't have to remember the playbook. The bot remembers for you.

---

## Quick reference: commands per scenario

| Scenario | Type | Wait for | Tap |
|---|---|---|---|
| 1. Idea → code | `/req`, `/triage`, `/req_promote --plan` | guide done | Read plan, Run |
| 2. Bug → fix | `/bug`, `/bug_promote` | round done | Ship |
| 3. Roadmap | `/run roadmap` | done | Read, then hand-create projects |
| 4. Audit | `/run audit` | done | Read, Promote, then `/run bugs` |
| 5. Ship | `/git_status`, `/ship` | confirm | Yes |
| 6. QA handoff | `/qa_handoff` | done (seconds) | Forward |

For the technical details of what's happening behind each step, see
[`FLOWS.md`](./FLOWS.md) and the per-flow `FLOW_*.md` docs.
