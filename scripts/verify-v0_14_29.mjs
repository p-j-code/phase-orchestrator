// v0.14.29 verifier — proves the test-runner auto-detection works.
//
// Bug class addressed: validator runner mismatch (reelchain BUG-1). See
// CHANGELOG.md [0.14.29] for the full story.
//
// What this verifies:
//
//   1. needsTsLoader correctly detects both static and dynamic .ts imports.
//      Includes the actual forms found in reelchain's smoke tests.
//
//   2. needsTsLoader does NOT flag plain JS that happens to contain the
//      string ".ts" in a comment or unrelated context (false-positive
//      guard for the regex).
//
//   3. hasTsxInProject scans workspace/, workspace/apps/*, and
//      workspace/packages/* package.json files.
//
//   4. resolveTestRunner returns the right tuple for each of the three
//      paths (plain node / npx tsx / --experimental-strip-types fallback).
//
//   5. validators.js no longer hard-codes process.execPath; the lazy
//      import('./test-runner.js') is present and the env passes the
//      ORCHESTRATOR_VALIDATOR_RUNNER tag through.
//
//   6. prompts/guide-system.md contains the no-runner-in-plan instruction
//      (closes the loop at the source).
//
// Run with: node scripts/verify-v0_14_29.mjs
// Exits 0 on full pass, 1 on any failure.

import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import chalk from 'chalk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

let passed = 0;
let failed = 0;
function check(label, ok, details) {
  if (ok) { console.log(chalk.green('  OK  '), label); passed += 1; }
  else    { console.log(chalk.red('  FAIL'), label, details ? chalk.dim(`— ${details}`) : ''); failed += 1; }
}

function readSrc(rel) {
  const p = resolve(REPO_ROOT, rel);
  if (!existsSync(p)) throw new Error(`Missing file: ${rel}`);
  return readFileSync(p, 'utf8');
}

console.log(chalk.bold('\n── v0.14.29 verifier ──\n'));

// ─── 1+2+3+4. Functional checks on the test-runner helper ──────────────────

const { needsTsLoader, hasTsxInProject, resolveTestRunner } =
  await import(resolve(REPO_ROOT, 'src/lib/test-runner.js'));

// Build a sandbox: a fake project with workspace/ containing a few tests and
// optional tsx in package.json deps. Tear down at the end.
const sandbox = mkdtempSync(join(tmpdir(), 'v0_14_29-verify-'));
const projDir = join(sandbox, 'proj');
const ws = join(projDir, 'workspace');
mkdirSync(ws, { recursive: true });
mkdirSync(join(ws, 'apps', 'api'), { recursive: true });
mkdirSync(join(ws, 'packages', 'shared'), { recursive: true });

// Test files for the regex check (mirror the patterns reelchain actually uses)
const TEST_FILES = {
  'pure-js.mjs': `
    import fs from "node:fs";
    import { foo } from "./bar.mjs";
    console.log("no ts here");
  `,
  'dynamic-ts.mjs': `
    import fs from "node:fs";
    const { adaptAiToDef } = await import(
      join(repoRoot, "packages/shared/src/render/aiAnimationAdapter.ts")
    );
  `,
  'static-ts.mjs': `
    import { foo } from "./bar.ts";
    console.log("static .ts import");
  `,
  'tsx-static.mjs': `
    import { Component } from "../src/Widget.tsx";
  `,
  'side-effect-ts.mjs': `
    import "./register.ts";
  `,
  'ts-string-in-comment.mjs': `
    // Note: the file "./foo.ts" is mentioned but not imported.
    import fs from "node:fs";
  `,
  'ts-string-in-data.mjs': `
    const PATHS = { docs: "./foo.ts" };
    import fs from "node:fs";
  `,
};
const testsDir = join(ws, 'tests');
mkdirSync(testsDir, { recursive: true });
for (const [name, src] of Object.entries(TEST_FILES)) {
  writeFileSync(join(testsDir, name), src);
}

// 1. Positive detections (must return true)
check(
  'needsTsLoader: dynamic .ts import → true',
  await needsTsLoader(join(testsDir, 'dynamic-ts.mjs')),
);
check(
  'needsTsLoader: static .ts import → true',
  await needsTsLoader(join(testsDir, 'static-ts.mjs')),
);
check(
  'needsTsLoader: .tsx import → true',
  await needsTsLoader(join(testsDir, 'tsx-static.mjs')),
);
check(
  'needsTsLoader: side-effect import "./x.ts" → true',
  await needsTsLoader(join(testsDir, 'side-effect-ts.mjs')),
);

// 2. False-positive guards (must return false)
check(
  'needsTsLoader: plain JS with no .ts import → false',
  !(await needsTsLoader(join(testsDir, 'pure-js.mjs'))),
);
check(
  'needsTsLoader: ".ts" only in a comment → false',
  !(await needsTsLoader(join(testsDir, 'ts-string-in-comment.mjs'))),
  'regex requires "import"/"from" keyword adjacent — comments do not match',
);
check(
  'needsTsLoader: ".ts" only in a data literal → false',
  !(await needsTsLoader(join(testsDir, 'ts-string-in-data.mjs'))),
);
check(
  'needsTsLoader: nonexistent file → false (graceful)',
  !(await needsTsLoader(join(testsDir, 'nope.mjs'))),
);

// 3. hasTsxInProject — sub-package scan
// First, tsx not present anywhere
writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'root', devDependencies: {} }));
writeFileSync(join(ws, 'apps', 'api', 'package.json'), JSON.stringify({ name: 'api', dependencies: {} }));
writeFileSync(join(ws, 'packages', 'shared', 'package.json'), JSON.stringify({ name: 'shared', dependencies: {} }));
check(
  'hasTsxInProject: nothing declares tsx → false',
  !(await hasTsxInProject(projDir)),
);

// Now add tsx to a sub-package (reelchain pattern)
writeFileSync(
  join(ws, 'apps', 'api', 'package.json'),
  JSON.stringify({ name: 'api', dependencies: { tsx: '4.22.3' } }),
);
check(
  'hasTsxInProject: tsx in workspace/apps/api → true',
  await hasTsxInProject(projDir),
);

// Clean it again, put tsx at root
writeFileSync(join(ws, 'apps', 'api', 'package.json'), JSON.stringify({ name: 'api', dependencies: {} }));
writeFileSync(
  join(ws, 'package.json'),
  JSON.stringify({ name: 'root', devDependencies: { tsx: '4.22.3' } }),
);
check(
  'hasTsxInProject: tsx at workspace root → true',
  await hasTsxInProject(projDir),
);

// Malformed package.json should not crash the scan
writeFileSync(join(ws, 'packages', 'shared', 'package.json'), '{ not valid json');
check(
  'hasTsxInProject: malformed package.json in tree → still works (skips bad file)',
  await hasTsxInProject(projDir),
);

// 4. resolveTestRunner — full integration
// Restore clean state: tsx present at root, fresh files
writeFileSync(join(ws, 'packages', 'shared', 'package.json'), JSON.stringify({ name: 'shared' }));

const r1 = await resolveTestRunner(join(testsDir, 'pure-js.mjs'), projDir);
check(
  'resolveTestRunner: pure JS → runner=node',
  r1.runner === 'node' && r1.cmd === process.execPath && r1.args[0] === join(testsDir, 'pure-js.mjs'),
  `got runner=${r1.runner} cmd=${r1.cmd}`,
);

const r2 = await resolveTestRunner(join(testsDir, 'dynamic-ts.mjs'), projDir);
check(
  'resolveTestRunner: .ts import + tsx in deps → runner=tsx',
  r2.runner === 'tsx' && r2.cmd === 'npx' && r2.args[0] === 'tsx',
  `got runner=${r2.runner} cmd=${r2.cmd} args=${JSON.stringify(r2.args)}`,
);

// Remove tsx everywhere → fallback to --experimental-strip-types
writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'root' }));
const r3 = await resolveTestRunner(join(testsDir, 'static-ts.mjs'), projDir);
check(
  'resolveTestRunner: .ts import + no tsx → runner=strip-types',
  r3.runner === 'strip-types' && r3.cmd === process.execPath && r3.args[0] === '--experimental-strip-types',
  `got runner=${r3.runner} cmd=${r3.cmd} args=${JSON.stringify(r3.args)}`,
);

// 5. Source-level checks on validators.js
const VALIDATORS = readSrc('src/lib/validators.js');
check(
  'validators.js no longer hard-codes process.execPath for .js/.mjs',
  !/const cmd = isJs \? process\.execPath : scriptPath/.test(VALIDATORS),
  'old line still present — auto-detector not wired',
);
check(
  'validators.js imports resolveTestRunner lazily',
  /await import\(['"]\.\/test-runner\.js['"]\)/.test(VALIDATORS),
);
check(
  'validators.js sets ORCHESTRATOR_VALIDATOR_RUNNER env',
  /ORCHESTRATOR_VALIDATOR_RUNNER/.test(VALIDATORS),
);

// 6. Source-level checks on the guide-system prompt
const GUIDE = readSrc('prompts/guide-system.md');
check(
  'prompts/guide-system.md forbids test-runner invocations in plan/prompt',
  /Do NOT write specific test-runner invocations/.test(GUIDE),
);
check(
  'prompts/guide-system.md references test-runner.js as the auto-detector',
  /test-runner\.js/.test(GUIDE),
);

// ─── Teardown ───────────────────────────────────────────────────────────────
try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }

// ─── Summary ────────────────────────────────────────────────────────────────
console.log('');
if (failed === 0) {
  console.log(chalk.bold.green(`✓ All ${passed} checks passed.`));
  process.exit(0);
} else {
  console.log(chalk.bold.red(`✗ ${failed} failed, ${passed} passed.`));
  process.exit(1);
}
