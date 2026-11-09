// src/lib/test-runner.js — auto-detect the right runtime for a JS/MJS test or
// validator script.
//
// Why this exists (v0.14.29 / reelchain BUG-1):
//   validators.js previously hard-coded `process.execPath` (plain node) for
//   any .js/.mjs validator script. Projects with TypeScript-importing smoke
//   tests (e.g. reelchain has 22 of 151 smokes that do dynamic `.ts` imports
//   like `await import("packages/shared/.../*.ts")`) would fail with
//   ERR_UNKNOWN_FILE_EXTENSION at spawn time. The error message looked
//   indistinguishable from a real test failure to the operator, so opus
//   budget was burned diagnosing "validator failures" that were actually
//   runner mismatches.
//
// Resolution priority for a `.js`/`.mjs` file:
//
//   1. File does NOT import any .ts/.tsx      → plain `node <file>`.
//   2. File imports .ts/.tsx AND any
//      workspace package.json declares tsx    → `npx tsx <file>`.
//   3. File imports .ts/.tsx AND no tsx       → `node --experimental-strip-types <file>`
//      detected                                  (Node ≥22.6). Will still fail
//                                                 on older Node, but with a
//                                                 clearer error than the
//                                                 default.
//
// The .ts detection is purely textual (regex on source) — we don't parse JS.
// False positives are safe (we run tsx on a file that didn't need it, no
// behaviour difference). False negatives are what bite us in production, so
// the regex is intentionally permissive: any line matching
// /\b(import|from)\s*\(?\s*["'][^"']*\.tsx?["']/ counts.
//
// Used by:
//   - src/lib/validators.js   (validator script spawn — the primary site)

import fs from 'node:fs/promises';
import path from 'node:path';

// Matches several forms:
//   import { x } from "./foo.ts"             — static named import
//   import "./register.ts"                   — bare side-effect import
//   import("./foo.ts")                       — dynamic, direct path
//   await import(join(root, "./foo.ts"))     — dynamic, path-join wrapped
//                                              (reelchain's primary pattern)
//   ... from "../Widget.tsx"                 — .tsx variants
//
// The match anchor is the keyword `import` or `from`; from there we allow up
// to 200 chars of intermediate code (whitespace, parens, helper calls like
// path.join/join/resolve, identifiers, commas) before the quoted .ts/.tsx
// path. The 200-char window is wide enough for any reasonable single-statement
// import expression and narrow enough to avoid matching unrelated `.ts`
// strings hundreds of lines away from any `import`/`from` keyword.
//
// The `[\s\S]` (not `.`) makes this multi-line safe — reelchain's tests put
// the import keyword and the path on separate lines.
const TS_IMPORT_RE = /\b(?:import|from)\b[\s\S]{0,200}?["'][^"'\n]*\.tsx?["']/;

/**
 * Does the given JS/MJS file import any .ts/.tsx file?
 *
 * Errors (missing file, read error) resolve to false — the caller will then
 * try to spawn the file with plain node, get a real error, and the operator
 * sees a normal failure path. Better than silently swallowing here.
 *
 * @param {string} filePath - absolute path to a .js/.mjs file
 * @returns {Promise<boolean>}
 */
export async function needsTsLoader(filePath) {
  try {
    const src = await fs.readFile(filePath, 'utf-8');
    return TS_IMPORT_RE.test(src);
  } catch {
    return false;
  }
}

/**
 * Scan the project's workspace for a `tsx` dependency. Checks:
 *   - workspace/package.json
 *   - workspace/apps/*\/package.json
 *   - workspace/packages/*\/package.json
 *
 * Returns true on first hit. Misses cost ~3-12 small file reads.
 *
 * @param {string} projectDir - absolute path to `projects/<name>/`
 * @returns {Promise<boolean>}
 */
export async function hasTsxInProject(projectDir) {
  const candidates = [];
  const workspace = path.join(projectDir, 'workspace');
  candidates.push(path.join(workspace, 'package.json'));
  for (const sub of ['apps', 'packages']) {
    try {
      const entries = await fs.readdir(path.join(workspace, sub));
      for (const e of entries) {
        candidates.push(path.join(workspace, sub, e, 'package.json'));
      }
    } catch { /* sub dir missing — fine */ }
  }
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(await fs.readFile(p, 'utf-8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.tsx) return true;
    } catch { /* skip unreadable / malformed package.json */ }
  }
  return false;
}

/**
 * Decide how to spawn a `.js`/`.mjs` validator/test file.
 *
 * @param {string} filePath - absolute path to script
 * @param {string} projectDir - absolute path to `projects/<name>/`
 * @returns {Promise<{ cmd: string, args: string[], runner: 'node'|'tsx'|'strip-types' }>}
 *
 * Example:
 *   resolveTestRunner('/abs/tests/foo.smoke.mjs', '/abs/projects/reelchain')
 *     // → { cmd: 'npx', args: ['tsx', '/abs/tests/foo.smoke.mjs'], runner: 'tsx' }
 *     //   if foo.smoke.mjs imports any .ts file and reelchain has tsx in deps.
 */
export async function resolveTestRunner(filePath, projectDir) {
  const needsTs = await needsTsLoader(filePath);
  if (!needsTs) {
    return { cmd: process.execPath, args: [filePath], runner: 'node' };
  }
  if (await hasTsxInProject(projectDir)) {
    return { cmd: 'npx', args: ['tsx', filePath], runner: 'tsx' };
  }
  return {
    cmd: process.execPath,
    args: ['--experimental-strip-types', filePath],
    runner: 'strip-types',
  };
}
