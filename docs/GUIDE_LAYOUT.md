# .guide/ Folder Layout (v2)

## Structure

```
projects/<name>/.guide/
├── brief.md                              user-provided spec
├── plan.json                             machine-readable plan
├── plan.md                               human-readable plan
├── session-ids.json                      mirror of SQLite session ids (audit trail)
├── README.md                             auto-generated index (optional)
│
├── phases/
│   ├── 01-schema-foundation/
│   │   ├── prompt.md                     guide writes
│   │   └── report.md                     dev writes
│   ├── 02-tds-deduction-backend/
│   │   ├── prompt.md
│   │   └── report.md
│   └── ... (one folder per phase)
│
├── reviews/
│   ├── after-2.md                        guide writes every N phases
│   ├── after-4.md
│   ├── after-6.md
│   └── after-8.md                        (final review now runs)
│
├── bug-rounds/
│   ├── round-1/
│   │   ├── bugs.md                       user-provided
│   │   ├── plan.json                     guide writes
│   │   ├── plan.md                       guide writes (human)
│   │   └── fixes/
│   │       ├── 01-section-206aa-validator/
│   │       │   ├── prompt.md             guide writes
│   │       │   └── report.md             dev writes
│   │       └── 02-dashboard-zero-state/
│   │           ├── prompt.md
│   │           └── report.md
│   └── round-2/ ... (when needed)
│
├── handoffs/
│   ├── handoff-2026-05-23-14-30-00.md    timestamped history
│   └── handoff-2026-06-01-09-15-22.md
│
└── archive/                              for old/stale stuff you want to keep but not see
```

## Naming

**Phase folders:** `NN-&lt;slug&gt;` where:
- `NN` = zero-padded phase number (`01`, `02`, ..., `08`)
- `&lt;slug&gt;` = title slugified (lowercase, non-alphanumeric → `-`, capped at 40 chars)

Example: "TDS Form 26Q JSON Preview + Reproducibility Hash" → `04-tds-form-26q-json-preview-reproducibility`

**Fix folders:** same convention inside `bug-rounds/round-R/fixes/`.

**Handoff files:** `handoff-&lt;ISO-timestamp&gt;.md` so multiple handoffs over a project's life preserve history instead of overwriting.

## Why this layout

| Before (flat) | After (nested) |
|--------------|----------------|
| Open `.guide/`: 30+ flat files | Open `.guide/`: 5-7 things |
| Phase 5 prompt + report mentally paired | Phase 5 folder contains both |
| Bug round files pollute the main phase list | Bug rounds in their own subtree |
| Single `handoff.md` overwrites on each handoff | All handoffs preserved by timestamp |

## Migration

Run once on existing projects:

```bash
npm run migrate-layout -- --dry-run   # preview
npm run migrate-layout                 # apply
```

Idempotent. Re-running on an already-migrated project skips it.

## Code touchpoints

All path construction goes through `src/lib/guide-paths.js`. If you want to change file layout in the future:

1. Edit `src/lib/guide-paths.js` (single source of truth)
2. Write a migration in `src/migrate-guide-layout.js`
3. Bump `guide_layout_version` in `config/defaults.json`
4. Update this doc

System prompts (`prompts/guide-system.md`, `prompts/dev-system.md`) reference paths abstractly — the orchestrator computes concrete paths at runtime and injects them into the user message. So the agents always get correct paths regardless of layout changes.

## Where session IDs live

- **SQLite** (`state/orchestrator.db`): primary, used by orchestrator runtime
- **`.guide/session-ids.json`**: mirror, written by `recordGuideSession()` and `recordDevSession()` in `guide-paths.js`

The JSON mirror exists for:
- Audit trail (grep across past sessions)
- Disaster recovery (if SQLite dies, session ids survive in git-tracked file)
- Visibility (you can `cat` it without DB tools)
