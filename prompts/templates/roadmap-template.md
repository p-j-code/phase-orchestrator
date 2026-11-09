# Roadmap — {project} — {date}

## Context

What's been built so far. One paragraph. Reference the brief and what shipped.

## Suggestions

Ordered: high priority → low priority. Within priority, least-dependency first.

---

### 1. <Title>

- **Description:** One paragraph.
- **Scope:** S (1-2 phases) | M (3-5) | L (6-9) | XL (multi-module)
- **Priority:** high | medium | low
- **Rationale (why now/later):** One line.
- **Dependencies:** What must ship first (current bug rounds, other modules, external APIs).
- **Risks:** What makes this harder than it looks.

---

### 2. <Title>

(same shape)

---

(continue for all suggestions)

---

## How to accept a suggestion

```bash
npm run roadmap-accept -- {project} --item N --new-project <name>
```

This creates `projects/<name>/` with `.guide/raw-thoughts.md` seeded from this roadmap item. Then:

```bash
# Edit raw-thoughts.md to refine
npm run brief -- <name>         # author structured brief
# Review .guide/brief.md, iterate raw-thoughts.md if needed
npm run go -- <name>            # plan + execute
```
