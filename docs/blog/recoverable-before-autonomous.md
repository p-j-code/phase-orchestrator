# Building an orchestrator for Claude Code: recoverable before autonomous

*By Prem Jethwa*

For months, my AI-assisted development loop looked like this. I opened a chat and
asked for a phased plan. I copied phase 1 into a fresh session, got code back, ran
it and committed it. Every three phases I pasted the code back into the planning
chat for a review. When that chat got long, I asked it for a handoff summary and
started a new one. When bugs showed up, I opened yet another session just for fixes.

It worked. But I was the scheduler, the memory, the courier and the QA department.
So I automated the loop, and I've now open-sourced the result:
**[Phase Orchestrator](https://github.com/p-j-code/phase-orchestrator)**, a phase-based development pipeline on
top of Claude Code.

This post covers the design decisions that mattered and the things that broke along
the way.

## The shape of it

You write a brief. A **guide** agent turns it into a plan of phases with acceptance
criteria. For each phase, the guide writes a prompt and a **dev** agent executes it
in a fresh Claude Code session. The phase ends in a git commit. Validators run, the
work is checked against its acceptance criteria, and every few phases the guide
reviews what has been built so far. The system pauses at checkpoints so a human can
look.

```text
brief ─▶ plan ─▶ [ phase prompt ─▶ dev session ─▶ commit ─▶ verify ] × N ─▶ review ─▶ …
```

Under the hood, it's roughly 86,000 lines of JavaScript (not counting tests) and
around 2,000 tests, built over about 400 commits. Most of that code exists for
one reason, which became the project's operating principle:

> **Recoverable before autonomous.**

An agent that runs for hours unattended will hit a rate limit, a crash, a flaky
test or a bad plan. The interesting engineering isn't making it *more* autonomous.
It's making every failure something you can see, understand and resume from.

## Decision 1: two agents, two sandboxes

The guide and the dev agent are separate `claude -p` subprocesses with different
system prompts and, crucially, **different working directories**. The guide writes
only to `.guide/` (plans, phase prompts, reviews, handoffs). The dev agent writes
only to `workspace/` (the actual code).

This sounds like bureaucracy, but it made the system debuggable. When something goes
wrong, I know which agent touched which file. The guide can't "helpfully" edit code
during a review, and the dev agent can't rewrite the plan to match what it built.

The guide keeps continuity by resuming its session ID across phases. When its context
gets too large, it writes a handoff document and a fresh guide session starts from
it. This is the same thing I used to do by hand, just written to a file I can read.

## Decision 2: git commits are the phase boundaries

In the manual workflow I shuttled zip files between sessions. In the orchestrator,
**every phase is a commit**. That one choice gave me a lot for free:

- An audit trail: what each phase changed, in reviewable diffs
- Rollback: a bad phase is a `git revert`, not an archaeology project
- Parallelism: later, when I added parallel phase lanes and fix lanes, each one got
  its own **git worktree** and branch. No two agents ever share a checkout.

## Decision 3: "tests pass" is not "done"

Early on, a phase counted as complete when the dev agent committed and the validator
gate (tests, syntax checks) passed. That turned out to be a weak signal. A phase could
pass every test while quietly skipping half its acceptance criteria. The 3-phase review
would catch it, but up to two phases late, after more work had been built on top.

So I added a verification loop: after the commit, a checker compares the work against
the phase's acceptance criteria in `plan.json` and routes failures back into a fix.
The periodic review still exists, but now it catches *drift* rather than basic omissions.

## Decision 4: everything durable, nothing in memory

Jobs live in a SQLite-backed queue with **renewable leases**. The web dashboard and the
worker are separate processes, so restarting the UI never interrupts a run. If the
worker dies mid-phase, the lease expires, restart reconciliation picks it up, and
the work resumes.

Every Claude call is recorded with tokens, cost and duration. A billing guard tracks
usage in the rolling 5-hour window and **pauses before the limit**, because a run that
stops cleanly at a checkpoint is far better than one that dies halfway through a
phase.

## Things that broke (and what they taught me)

**Two machines, one account, two databases.** I ran the orchestrator on my laptop
and on an always-on home server. Each install had its own SQLite database, so each one's
rate-limit circuit breaker and call leases were blind to the other. They happily
raced against the same account. The fix was a small, boring policy file that names
the single install allowed to execute. Every other install fails closed. Lesson:
*coordination that lives in a local database only coordinates locally.*

**Headless sessions ignore your permissions.** `claude -p` ignores a workspace's
`.claude/settings.json` permission rules until that folder is marked trusted, and the
trust prompt only exists in interactive mode. On a headless server, nobody can click it.
The orchestrator now marks each workspace trusted before every spawn, atomically
and without disturbing the rest of the CLI's state.

**Rate-limit cascades.** When the account hit its limit, every queued job would spawn,
get rejected, retry and get rejected again. A shared circuit breaker now records the
reset time and blocks new spawns until then, so one rejection doesn't turn into fifty.

**Prompt caching is a design constraint, not a setting.** I was injecting per-call
context (the latest diffs, the repo map, review notes) into the system prompt. Every
call changed the system prompt, so the cached prefix was useless. Now the system
prompt holds only stable context, and anything that changes per call goes in the
user prompt. Tests pin this shape so it can't silently regress.

**Don't let an LLM write what a parser can.** Agents kept generating "project context"
docs full of file trees and function lists that went stale as soon as a file moved.
The orchestrator now builds a **deterministic repo map** from the code at every spawn.
The LLM-written context is limited to what static analysis can't produce: *why* the
architecture is shaped this way, conventions, and gotchas.

## What I'd tell someone building something similar

1. **Make state boring and visible.** Plain files and git commits beat clever
   in-memory state. When an agent does something strange, you need to be able to
   read exactly what it saw.
2. **Separate the planner from the builder.** Different prompts, different directories,
   different permissions.
3. **Define "done" explicitly.** Acceptance criteria, checked by something other than
   the agent that did the work.
4. **Design for the crash.** Leases, checkpoints, resumable sessions. Assume the
   process dies at the worst possible moment, because it will.
5. **Spend tokens like they're yours.** They are. Record every call, respect the
   limits, and keep your prompts cache-friendly.

## Try it

The code, docs and setup instructions are on GitHub: **[p-j-code/phase-orchestrator](https://github.com/p-j-code/phase-orchestrator)**.
It's MIT-licensed. It's a personal tool that I use daily, so expect rough edges.
Issues and PRs are welcome.

If you're building agent infrastructure too, I'd love to compare notes.
