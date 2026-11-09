# Brief — `linkstash` URL-shortener API

> FROZEN eval fixture (Phase 84 / P6). Do not edit — baselines depend on byte-stability.

## Goal

A minimal single-process URL-shortener HTTP API, `linkstash`, built on Node 18+
with the built-in `node:http` module (no Express, no framework). Links persist in
a local SQLite file via `better-sqlite3` (already an allowed dependency). One
`src/server.mjs` entrypoint plus a thin store module.

## Functional requirements

- **FR1 — shorten:** `POST /shorten` with a JSON body `{ "url": "<http(s) url>" }`
  validates the URL, generates a short 6-char base62 slug, stores the mapping, and
  returns `201` with `{ "slug", "short_url" }`. An invalid/missing url returns
  `400` with a JSON error. A slug collision retries with a new slug.
- **FR2 — redirect:** `GET /:slug` looks up the slug and responds `302` with a
  `Location` header to the original url, incrementing a per-slug hit counter. An
  unknown slug returns `404` with a JSON error.

## Non-functional

- Persistence via one `better-sqlite3` table created idempotently at boot.
- All request handling is async; JSON bodies are size-capped and parsed safely
  (a malformed body returns `400`, never crashes the process).
- Paths built with `path.join`; the DB file path is configurable via an env var
  with a sane default.

## Definition of done

- Both FRs implemented across `src/server.mjs` and a store module.
- A `.mjs` test suite drives the server over a real ephemeral port covering
  shorten → redirect, invalid-url `400`, and unknown-slug `404`, and passes.
- `README.md` documents both endpoints with a `curl` example each.
