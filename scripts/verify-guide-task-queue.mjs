#!/usr/bin/env node
// verify-guide-task-queue.mjs
//
// Proves D2 — `/run <project> guide --task <type>` carries a guide task across
// the queue boundary, with the right safety classification:
//   • queue-safe tasks (project-state + disk only)  -> enqueue as args.task
//   • known-but-unsafe (need round/fix-id/requirement) -> reject, point to CLI
//   • unknown tasks                                  -> reject with the safe list
//
// Imports only src/lib/guide-tasks.js (no heavy deps), so it runs anywhere.
// Run:  node scripts/verify-guide-task-queue.mjs

import {
  parseFlagValue, classifyGuideTask,
  KNOWN_GUIDE_TASKS, QUEUE_SAFE_GUIDE_TASKS,
} from '../src/lib/guide-tasks.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

console.log('\nparseFlagValue — both --flag value and --flag=value');
ok('--task value form', parseFlagValue(['--task', 'review'], '--task') === 'review');
ok('--task=value form', parseFlagValue(['--task=review'], '--task') === 'review');
ok('flag absent -> null', parseFlagValue(['--unattended'], '--task') === null);
ok('flag present, no value -> null', parseFlagValue(['--task'], '--task') === null);
ok('flag followed by another flag -> null', parseFlagValue(['--task', '--unattended'], '--task') === null);
ok('coexists with other flags', parseFlagValue(['--unattended', '--task', 'next-prompt'], '--task') === 'next-prompt');
ok('non-array input -> null', parseFlagValue(undefined, '--task') === null);

console.log('\nclassifyGuideTask — queue-safe tasks enqueue');
for (const t of ['plan', 'next-prompt', 'review', 'handoff', 'workspace-claude-md']) {
  const v = classifyGuideTask(t);
  ok(`${t} -> ok, args.task=${t}`, v.ok === true && v.task === t);
}

console.log('\nclassifyGuideTask — context-needing tasks are rejected (CLI-only)');
for (const t of ['bug-plan', 'fix-prompt', 'requirement-refine']) {
  const v = classifyGuideTask(t);
  ok(`${t} -> rejected as unsafe`, v.ok === false && v.reason === 'unsafe');
}

console.log('\nclassifyGuideTask — unknown task rejected with safe list');
{
  const v = classifyGuideTask('frobnicate');
  ok('unknown -> reason unknown', v.ok === false && v.reason === 'unknown');
}

console.log('\nclassifyGuideTask — no --task means default (plan) path');
{
  const v = classifyGuideTask(null);
  ok('null -> ok with task=null (caller defaults to plan)', v.ok === true && v.task === null);
}

console.log('\nregistry invariants');
ok('every queue-safe task is also a known task', [...QUEUE_SAFE_GUIDE_TASKS].every((t) => KNOWN_GUIDE_TASKS.has(t)));
ok('the unsafe trio is known but NOT queue-safe',
  ['bug-plan', 'fix-prompt', 'requirement-refine'].every((t) => KNOWN_GUIDE_TASKS.has(t) && !QUEUE_SAFE_GUIDE_TASKS.has(t)));

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
