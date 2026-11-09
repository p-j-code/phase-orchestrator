// runValidators extraRules injection (Phase 81 / brief 05 P4a) — pure, no spawns.
//
// Proves a synthetic validator rule can be injected PROGRAMMATICALLY (never
// written to validators.json) and PARTICIPATES in the gate: after the merge it
// is selected by matchValidators exactly like a configured rule. All assertions
// run against the pure merge + match layer, so this suite makes zero real
// spawns and touches no DB.
//
// Run with: node --test src/lib/validators-extra-rules.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildEffectiveValidatorConfig, matchValidators } from './validators.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SYNTH = '__test_first_redcheck__';
const extraValidators = { [SYNTH]: { script: 'validators/__authored__.test.mjs', timeout_ms: 30000 } };
const extraRules = [{ match: { always: true }, run: [SYNTH] }];

test('an injected rule + validator participate in the gate (matchValidators selects the synthetic validator)', () => {
  // Baseline: a project with NO validators.json and NO injected rules → nothing.
  assert.equal(buildEffectiveValidatorConfig(null, {}), null);

  const cfg = buildEffectiveValidatorConfig(null, { extraRules, extraValidators });
  assert.ok(cfg, 'an effective cfg is built purely from injected rules (no disk config)');
  assert.deepEqual(matchValidators(cfg, { phase: 3 }), [SYNTH], 'the injected rule is selected for the phase');
});

test('injected rules merge ONTO a loaded validators.json without mutating it', () => {
  const loaded = {
    validators: { lint: { script: 'validators/lint.sh' } },
    rules: [{ match: { always: true }, run: ['lint'] }],
  };
  const loadedSnapshot = JSON.stringify(loaded);

  const cfg = buildEffectiveValidatorConfig(loaded, { extraRules, extraValidators });
  // Both the configured `lint` and the injected synthetic validator run.
  assert.deepEqual(matchValidators(cfg, { phase: 1 }).sort(), [SYNTH, 'lint'].sort());
  // The loaded config object was not mutated in place (no disk write, no aliasing).
  assert.equal(JSON.stringify(loaded), loadedSnapshot, 'loaded validators.json is untouched');
});

test('an injected rule whose validator is undefined is filtered out (the companion extraValidators is what makes it participate)', () => {
  // Rule references SYNTH but NO extraValidators defines it → matchValidators
  // filters it out, so it does NOT participate. This is exactly why redCheck
  // wiring (P4b) must pass extraValidators alongside extraRules.
  const cfg = buildEffectiveValidatorConfig(null, { extraRules });
  assert.deepEqual(matchValidators(cfg, { phase: 3 }), [], 'undefined-target rule does not run');
});

test('runValidators exposes the extraRules / extraValidators seam and routes through buildEffectiveValidatorConfig', () => {
  // Source-level pin (a real runValidators call spawns + hits the DB): the seam
  // exists in the signature and the loaded config is merged via the pure helper.
  const src = readFileSync(path.join(__dirname, 'validators.js'), 'utf-8');
  const fnStart = src.indexOf('export async function runValidators(');
  assert.ok(fnStart > -1, 'runValidators found');
  const sig = src.slice(fnStart, src.indexOf('\n', fnStart)); // the one-line signature
  assert.match(sig, /extraRules = \[\]/, 'extraRules param present (default [])');
  assert.match(sig, /extraValidators = \{\}/, 'extraValidators param present (default {})');
  const head = src.slice(fnStart, fnStart + 800);
  assert.match(head, /buildEffectiveValidatorConfig\(loaded, \{ extraRules, extraValidators \}\)/);
});
