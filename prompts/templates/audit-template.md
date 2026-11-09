# Code Audit — {project} — {date}

## Scope

What was audited (files, modules, scope of coverage) and what was NOT audited (out-of-scope or unverifiable items).

## Summary

- Total findings: N
- Critical: N
- Major: N
- Minor: N
- Deferred-OK: N

Top-3 recommendations the user should address first.

---

## Critical

Issues with concrete failure scenarios — security holes, data loss, regulatory violations, runtime crashes on common paths.

### C1 — <one-line title>

- **File(s):** path/to/file.js:120-145
- **What's wrong:** Specific defect described.
- **Why it matters:** Concrete failure scenario or attack.
- **Suggested fix:** One-paragraph approach. No code.

---

## Major

Incorrect business logic, missing auth scoping, race conditions, broken acceptance criteria.

### M1 — <title>

(same shape as Critical)

---

## Minor

Code smells, dead code, test gaps, accessibility issues, doc gaps.

### m1 — <title>

(same shape)

---

## Deferred-OK

Tech debt that's documented and acceptable to ship.

### D1 — <title>

(same shape; explain WHY OK to defer)

---

## What I couldn't verify

Specific claims or behaviors that couldn't be checked from code alone (e.g., "Real NSDL FVU validator wasn't run; field positions may still drift").

---

## Promote to bugs-round-N

<!-- IMPORTANT: keep the heading above exactly as written — spaces between words, no .md suffix.
     The orchestrator parses this heading programmatically.

     v0.14.34 severity gate:
     - CRITICAL and MAJOR findings ONLY in this section.
     - MINOR / DEFERRED-OK findings go to .guide/audit-backlog.md (append, dated heading,
       "### M1 — <title>" style headings — never "Bug N" style, the parser scans for those).
     - Zero CRITICAL/MAJOR findings → keep this heading and write exactly one line under it:
       (nothing to promote — no CRITICAL or MAJOR findings)
       That line is machine-detected and stops the audit→fix auto-chain cleanly. -->

Copy-paste-ready bug entries for the next bug round. Already formatted for `bugs.md` consumption. CRITICAL and MAJOR only.

### Bug #1 — <Critical: C1's title>

**Steps to reproduce:** ...
**Expected:** ...
**Actual:** ...
**Affected files:** ...

(repeat for each CRITICAL/MAJOR finding)
