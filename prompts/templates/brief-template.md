# Brief — {project name}

## Goal in one paragraph

A single paragraph stating what this project delivers, why, and for whom. If you can't say it in one paragraph, scope is too big.

## Context

- **Parent system:** (e.g., "extends existing BillFlow GST billing SaaS")
- **Tech stack:** (CommonJS backend, React frontend, Mongoose, etc.)
- **User profile:** (who will use this; one sentence)

## Functional requirements

Numbered list. Each item testable. Order by user-visible value.

1. ...
2. ...

## Non-functional requirements

- Performance, scale, security, accessibility, compliance, etc.
- Be specific. "Fast" is not a requirement. "P95 list endpoint < 200ms with 10k records" is.

## Conventions to follow

Existing patterns in the codebase that this project must respect:
- File organization (e.g., `backend/controllers/X.js` matches existing CRUD pattern)
- Naming (CommonJS vs ESM, money as Number, snake_case in DB vs camelCase in API)
- Cross-cutting concerns (auth middleware, audit logging, error handling)

## Out of scope

Explicitly listed. Things users might assume are included but are not. If a future module covers them, name it.

- ...
- ...

## Definition of done

What manual QA must verify to declare this shipped. End-to-end user journey, ideally.

## Open questions

If anything is unclear, list it here. The brief author will populate `.guide/brief-questions.md` with these.
