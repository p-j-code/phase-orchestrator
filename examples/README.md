# examples/

This directory holds **reference templates** that ship with the orchestrator.
They are NOT live data and are NOT loaded by any runtime code — they are
sample content you can copy into your own `projects/<name>/` tree as a
starting point.

## examples/validators/

Per-project validator definitions and routing extensions. The `billflow-tds`
subdirectory holds the original reference set that previously lived at
`projects/billflow-tds/`. It was moved here in v0.14.6 (BUG-2): when bundled
under `projects/`, every release zip's `unzip -o` would silently overwrite
operator edits to those files. `examples/` is excluded from the `projects/*`
guard in `.releaseignore`, so these CAN ship in the release zip and CAN be
overwritten by apply — that's appropriate for reference templates.

### To use them in a new project

```bash
# Copy the reference set into a live project of yours.
cp -r examples/validators/billflow-tds/* projects/<your-project>/
```

Then edit `projects/<your-project>/validators.json` and the files under
`validators/` to suit. The copies under `projects/` are yours — they will
NOT be touched by future `unzip -o` applies of the release zip.

### Custody note

These are reference / starter content. Treat them like the sample code in
any framework's `examples/` directory: read them, copy them, mutate them.
Do not edit them in place expecting your edits to persist across releases —
that's what your `projects/` tree is for.
