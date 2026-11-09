// Tests for config-validator's validateDenyRules (Phase 45) — each
// security.deny_rules entry must match the Tool(pattern) shape, and a bad
// entry must throw an error naming the offending config layer.
//
// Run with: node --test src/config-validator.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateDenyRules, validateTaskProfiles } from './config-validator.js';

test('validateDenyRules: a well-formed list passes', () => {
  assert.doesNotThrow(() => validateDenyRules([
    'Read(../../../config/**)',
    'Read(~/.ssh/**)',
    'Bash(curl:*)',
  ], 'defaults (config/defaults.json)'));
});

test('validateDenyRules: null/undefined (layer omits the key) is a no-op', () => {
  assert.doesNotThrow(() => validateDenyRules(null, 'user overrides'));
  assert.doesNotThrow(() => validateDenyRules(undefined, 'user overrides'));
});

test('validateDenyRules: rejects a malformed rule and names the offending config layer', () => {
  assert.throws(
    () => validateDenyRules(['not a tool pattern'], 'project overrides (projects/foo/project.json)'),
    (err) => {
      assert.match(err.message, /project overrides \(projects\/foo\/project\.json\)/);
      assert.match(err.message, /not a tool pattern/);
      assert.match(err.message, /Tool\(pattern\)/);
      return true;
    },
  );
});

test('validateDenyRules: rejects a non-string entry, naming the layer', () => {
  assert.throws(
    () => validateDenyRules([42], 'user overrides (~/.ashmero-orchestrator/user.json)'),
    /user overrides \(~\/\.ashmero-orchestrator\/user\.json\)/,
  );
});

test('validateDenyRules: rejects a non-array value, naming the layer', () => {
  assert.throws(
    () => validateDenyRules('Read(../**)', 'defaults (config/defaults.json)'),
    /defaults \(config\/defaults\.json\): security\.deny_rules must be an array/,
  );
});

// ─── Tests for validateTaskProfiles (Phase 46) ──────────────────────────────
// tools.task_profiles maps a task name -> array-of-tool-name-strings override.
// Task names themselves are deliberately unrestricted (forward-compat); only
// the value shape is validated, per-layer, naming the offending layer.

test('validateTaskProfiles: a well-formed map passes', () => {
  assert.doesNotThrow(() => validateTaskProfiles({
    'dev-execution': ['Read', 'Write', 'Edit'],
    'acceptance-check': ['Read', 'Grep'],
  }, 'defaults (config/defaults.json)'));
});

test('validateTaskProfiles: null/undefined (layer omits the key) is a no-op', () => {
  assert.doesNotThrow(() => validateTaskProfiles(null, 'user overrides'));
  assert.doesNotThrow(() => validateTaskProfiles(undefined, 'user overrides'));
});

test('validateTaskProfiles: empty object (default {}) passes', () => {
  assert.doesNotThrow(() => validateTaskProfiles({}, 'defaults (config/defaults.json)'));
});

test('validateTaskProfiles: task names are unrestricted — an unusual-looking key still passes as long as the value is an array of strings', () => {
  assert.doesNotThrow(() => validateTaskProfiles({
    'Some Future Task 2.0': ['Read'],
  }, 'defaults (config/defaults.json)'));
});

test('validateTaskProfiles: rejects a non-array value for a task, naming the offending config layer', () => {
  assert.throws(
    () => validateTaskProfiles({ 'dev-execution': 'Read' }, 'project overrides (projects/foo/project.json)'),
    (err) => {
      assert.match(err.message, /project overrides \(projects\/foo\/project\.json\)/);
      assert.match(err.message, /dev-execution/);
      return true;
    },
  );
});

test('validateTaskProfiles: rejects an array containing a non-string entry, naming the layer', () => {
  assert.throws(
    () => validateTaskProfiles({ 'dev-execution': ['Read', 42] }, 'user overrides (~/.ashmero-orchestrator/user.json)'),
    /user overrides \(~\/\.ashmero-orchestrator\/user\.json\)/,
  );
});

test('validateTaskProfiles: rejects a non-object value, naming the layer', () => {
  assert.throws(
    () => validateTaskProfiles(['dev-execution'], 'defaults (config/defaults.json)'),
    /defaults \(config\/defaults\.json\): tools\.task_profiles must be an object/,
  );
});
