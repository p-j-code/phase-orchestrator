import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDeltaAcceptancePlan } from './context-delta-verification.js';

const cfg = { context_compiler: { enabled: true, mode: 'assist', delta_acceptance_recheck: true } };
const phaseMeta = { acceptance_criteria: ['A works', 'B works', 'C works'] };
const baselineVerdict = {
  verdict: 'fail',
  criteria: [
    { criterion: 'A works', status: 'met' },
    { criterion: 'B works', status: 'unmet' },
    { criterion: 'C works', status: 'met' },
  ],
};
const manifest = {
  confidence: 0.9,
  ranked_files: [{ path: 'src/a.js' }, { path: 'src/b.js' }, { path: 'src/c.js' }],
  criteria_map: [
    { criterion: 'A works', production_files: ['src/a.js'] },
    { criterion: 'B works', production_files: ['src/b.js'] },
    { criterion: 'C works', production_files: ['src/c.js'] },
  ],
};

test('delta plan includes failed criteria plus previously-met criteria touched by the repair', () => {
  const plan = resolveDeltaAcceptancePlan({ cfg, manifest, compiledUse: {}, baselineVerdict, phaseMeta, changedFiles: ['src/b.js', 'src/c.js'] });
  assert.equal(plan.delta, true);
  assert.deepEqual(plan.phaseMeta.acceptance_criteria, ['B works', 'C works']);
});

test('delta plan fails safe for unmapped edits, incomplete baseline, shadow, or degraded enforce', () => {
  assert.equal(resolveDeltaAcceptancePlan({ cfg, manifest, compiledUse: {}, baselineVerdict, phaseMeta, changedFiles: ['src/unknown.js'] }).delta, false);
  assert.equal(resolveDeltaAcceptancePlan({ cfg, manifest, compiledUse: {}, baselineVerdict: { criteria: baselineVerdict.criteria.slice(1) }, phaseMeta, changedFiles: ['src/b.js'] }).delta, false);
  assert.equal(resolveDeltaAcceptancePlan({ cfg: { context_compiler: { enabled: true, mode: 'shadow', delta_acceptance_recheck: true } }, manifest, compiledUse: {}, baselineVerdict, phaseMeta, changedFiles: ['src/b.js'] }).delta, false);
  assert.equal(resolveDeltaAcceptancePlan({ cfg, manifest, compiledUse: { degraded: true }, baselineVerdict, phaseMeta, changedFiles: ['src/b.js'] }).delta, false);
  assert.equal(resolveDeltaAcceptancePlan({
    cfg, manifest: { ...manifest, criteria_map: manifest.criteria_map.slice(1) }, compiledUse: {}, baselineVerdict, phaseMeta, changedFiles: ['src/b.js'],
  }).delta, false, 'missing criterion mapping forces the full acceptance check');
  assert.equal(resolveDeltaAcceptancePlan({
    cfg, manifest, compiledUse: {},
    baselineVerdict: { criteria: [baselineVerdict.criteria[0], baselineVerdict.criteria[0], baselineVerdict.criteria[2]] },
    phaseMeta, changedFiles: ['src/b.js'],
  }).delta, false, 'duplicate baseline keys cannot impersonate exact authored coverage');
});
