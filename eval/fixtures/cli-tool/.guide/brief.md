# Brief — `tod18` CLI task tracker

> FROZEN eval fixture (Phase 84 / P6). Do not edit — baselines depend on byte-stability.

## Goal

A tiny single-user command-line task tracker, `tod18`, that stores tasks in a
local JSON file (`~/.tod18.json`). Node 18+, ESM, zero runtime dependencies
beyond the Node standard library. Distributed as one `bin/tod18.mjs` entrypoint.

## Functional requirements

- **FR1 — add:** `tod18 add "<text>"` appends a task with a monotonic integer id,
  the text, `done: false`, and an ISO-8601 `created_at`. Prints the new id.
- **FR2 — list:** `tod18 list` prints all tasks, one per line, as
  `[<id>] [ ] <text>` (or `[x]` when done), open tasks first. `--all` includes
  done tasks; default hides them once done.
- **FR3 — done:** `tod18 done <id>` marks a task done and prints a confirmation;
  an unknown id exits non-zero with a clear message on stderr.
- **FR4 — remove:** `tod18 rm <id>` deletes a task; unknown id exits non-zero.
- **FR5 — storage:** all commands read/write `~/.tod18.json` atomically (write a
  temp file then rename) so a crash mid-write never corrupts the store. A missing
  store reads as an empty task list.

## Non-functional

- Pure Node standard library; no npm dependencies.
- Every file path built with `path.join`; all file IO async (`fs/promises`).
- Unknown command or missing argument prints usage and exits non-zero.

## Definition of done

- All five FRs implemented in `bin/tod18.mjs` (plus any helper modules).
- A `.mjs` test suite covers add → list → done → list --all → rm, and the
  atomic-write / missing-store behaviour, and passes.
- `README.md` documents each command with one example.
