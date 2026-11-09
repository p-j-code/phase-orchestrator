// Repo invariant (Phase 67 / brief 05 P2) — src/lib/no-raw-git-spawn.test.mjs
//
// ALL git goes through src/lib/git.js (the single point that owns timeout +
// group-kill + GIT_TERMINAL_PROMPT=0). This lint-style test walks every
// non-test .js source file under src/ and asserts none of them spawn git
// directly (a `spawn('git', ...)` / `spawn("git"...)` / spawn(`git`...) form).
// src/lib/git.js is the ONLY file allowed to; test fixtures use execSync('git ...')
// for setup, which is out of scope here.
//
// Run with: node --test src/lib/no-raw-git-spawn.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '..');           // .../src
const GIT_JS = path.join(SRC_DIR, 'lib', 'git.js');      // the ONLY exemption

// spawn( <optional ws> <quote> git <quote|space>  — matches ', ", and ` forms.
const RAW_GIT_SPAWN = /spawn\(\s*['"`]git['"`\s]/;

function collectJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      out.push(...collectJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out;
}

test("no source file outside src/lib/git.js spawns git directly (spawn('git', ...))", () => {
  const offenders = [];
  for (const file of collectJsFiles(SRC_DIR)) {
    if (path.resolve(file) === GIT_JS) continue; // git.js owns the low-level spawns
    const src = readFileSync(file, 'utf-8');
    if (RAW_GIT_SPAWN.test(src)) offenders.push(path.relative(SRC_DIR, file));
  }
  assert.deepEqual(
    offenders, [],
    `raw git spawn found outside src/lib/git.js — route these through runGit:\n  ${offenders.join('\n  ')}`,
  );
});

test('the lint regex actually matches the forms it claims to (self-check)', () => {
  assert.ok(RAW_GIT_SPAWN.test(`spawn('git', args)`));
  assert.ok(RAW_GIT_SPAWN.test(`spawn("git", args)`));
  assert.ok(RAW_GIT_SPAWN.test('spawn(`git`, args)'));
  assert.ok(RAW_GIT_SPAWN.test(`spawn(  'git', [])`));
  // Not a git spawn — must NOT match.
  assert.ok(!RAW_GIT_SPAWN.test(`spawn('claude', args)`));
  assert.ok(!RAW_GIT_SPAWN.test(`runGit(workspaceDir, ['status'])`));
});
