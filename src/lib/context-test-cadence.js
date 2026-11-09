// Hybrid Context Compiler — deterministic test-scope policy.
//
// The compiler may narrow the built-in fallback gate to related test files on
// routine assist/enforce phases. The development-focused acceptance cadence
// can also request conservative path-based discovery between its full-suite
// checkpoints, without trusting a shadow compiler manifest. Configured
// validators.json chains remain authoritative and are never filtered here.

const TEST_PATH_RE = /(^|\/)(test|tests|__tests__|spec|specs)(\/|$)|\.(test|spec)\.[^.]+$|(^|\/)test-[^/]+\.[^.]+$/i;

export function isTestPath(file) {
  return TEST_PATH_RE.test(String(file || '').replaceAll('\\', '/'));
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function uniquePaths(paths) {
  return [...new Set((Array.isArray(paths) ? paths : [])
    .map((value) => String(value || '').replaceAll('\\', '/').replace(/^\.\//, ''))
    .filter((value) => value && !value.startsWith('-') && !value.startsWith('/') && !value.split('/').includes('..')))]
    .sort();
}

/**
 * Decide whether the built-in fallback gate should run targeted tests or the
 * full suite. This never returns "skip": routine work still receives a real
 * deterministic gate, just a smaller one when evidence is strong enough.
 */
export function resolveContextTestPlan({
  cfg,
  manifest,
  phaseOrdinal = null,
  isFinalPhase = false,
  complexity = null,
  checkpoint = null,
  repair = false,
  fix = false,
  enforceDegraded = false,
  changedFiles = [],
  changedFilesKnown = true,
} = {}) {
  const compiler = cfg?.context_compiler || {};
  const mode = ['shadow', 'assist', 'enforce'].includes(compiler.mode) ? compiler.mode : 'shadow';
  let compilerManaged = false;
  const historical = (reason) => ({ scope: 'full', test_files: [], reason, compiler_managed: compilerManaged });

  const verifyCadence = cfg?.verify?.cadence || {};
  const acceptanceEvery = positiveInt(verifyCadence.every_n_phases, 3);
  const developmentCadence = !fix && (verifyCadence.mode ?? 'every-phase') === 'checkpoints';
  const alwaysComplexities = new Set(Array.isArray(verifyCadence.always_complexities)
    ? verifyCadence.always_complexities.map((value) => String(value).toLowerCase())
    : ['high', 'critical']);
  const alwaysCheckpoints = new Set(Array.isArray(verifyCadence.always_checkpoints)
    ? verifyCadence.always_checkpoints.map((value) => String(value).toLowerCase())
    : ['architecture', 'schema', 'external-integration', 'destructive']);

  if (!changedFilesKnown) return historical('changed-file set is unavailable; full suite required');
  if (isFinalPhase) return historical('final phase checkpoint');
  if (alwaysComplexities.has(String(complexity || '').toLowerCase())) return historical(`${complexity} complexity checkpoint`);
  if (alwaysCheckpoints.has(String(checkpoint || '').toLowerCase())) return historical(`${checkpoint} checkpoint`);

  const changed = uniquePaths(changedFiles);

  // Outside compiler assist/enforce, the development-focused cadence still
  // saves repeat full-suite work safely: a routine phase asks validators.js to
  // discover direct path-based tests. Discovery fails closed to the full suite
  // when even one production/config path cannot be mapped. The periodic LLM
  // acceptance checkpoint is also the periodic full-test checkpoint.
  if (compiler.enabled !== true || mode === 'shadow') {
    if (developmentCadence && Number.isInteger(phaseOrdinal) && phaseOrdinal > 0
        && phaseOrdinal % acceptanceEvery !== 0) {
      return {
        scope: 'candidate',
        test_files: changed.filter(isTestPath).slice(0, 25),
        changed_files: changed,
        compiler_managed: false,
        reason: `routine phase between full-suite/acceptance checkpoints (every ${acceptanceEvery} phases)`,
      };
    }
    return historical(compiler.enabled !== true
      ? 'compiler is disabled and no development-focused targeted-test interval applies'
      : 'compiler is shadow-only; full suite at this checkpoint');
  }

  if (compiler.targeted_tests !== true || !manifest) {
    return historical('targeted tests are disabled or no compiled manifest is available');
  }
  compilerManaged = true;
  if (enforceDegraded) return historical('enforce evidence guard degraded; full suite required');
  if (manifest.test_plan?.requires_full_suite) {
    return historical(manifest.test_plan.reason || 'compiled risk assessment requires the full suite');
  }

  const mappedFiles = new Set((manifest.ranked_files || []).map((file) => file.path));
  const unmappedProduction = changed.filter((file) => !isTestPath(file) && !mappedFiles.has(file));
  if (unmappedProduction.length > 0) {
    return historical(`changed production/config files were outside compiled evidence: ${unmappedProduction.slice(0, 5).join(', ')}`);
  }

  const interval = positiveInt(compiler.full_suite_every_checkpoints, 3);
  const compilerAcceptanceEvery = developmentCadence
    ? acceptanceEvery
    : 1;
  const checkpointIndex = Number.isInteger(phaseOrdinal) && phaseOrdinal > 0 && phaseOrdinal % compilerAcceptanceEvery === 0
    ? phaseOrdinal / compilerAcceptanceEvery
    : null;
  if (!repair && checkpointIndex != null && checkpointIndex % interval === 0) {
    return historical(`periodic full-suite checkpoint ${checkpointIndex} (every ${interval} acceptance checkpoints)`);
  }

  const changedTests = changed.filter(isTestPath);
  const testFiles = uniquePaths([...(manifest.test_plan?.targeted_files || []), ...changedTests]).slice(0, 25);
  if (testFiles.length === 0) return historical('compiler found no safe targeted test files');
  return {
    scope: 'targeted',
    test_files: testFiles,
    compiler_managed: true,
    reason: repair
      ? 'acceptance-repair delta has compiler-mapped tests'
      : `routine phase between full-suite checkpoints (every ${interval} acceptance checkpoints)`,
  };
}

/** Only pass file arguments to common runners with stable path-filter syntax. */
export function supportsTargetedTestArgs(script) {
  return resolveTargetedTestCommand(script, ['test/example.test.js']) != null;
}

function shellWords(value) {
  if (!value || /\r|\n|&&|\|\||[;|`$<>]/.test(value)) return null;
  const words = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+)/g;
  let match;
  let consumed = '';
  while ((match = re.exec(value)) !== null) {
    consumed += match[0];
    words.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\([\\"])/g, '$1'));
  }
  if (consumed.replace(/\s/g, '') !== value.replace(/\s/g, '')) return null;
  return words;
}

/**
 * Build argv without a shell. For Node's test runner, replace an embedded
 * full-suite glob instead of appending to it (which would still run all tests).
 */
export function resolveTargetedTestCommand(script, testFiles) {
  const files = uniquePaths(testFiles);
  if (!files.length) return null;
  const words = shellWords(String(script || '').trim());
  if (!words?.length) return null;
  const executable = words[0].split('/').pop()?.toLowerCase();
  if (executable === 'node') {
    const testIndex = words.indexOf('--test');
    if (testIndex < 0) return null;
    const prefix = words.slice(1, testIndex + 1);
    // Prefix flags get the same scrutiny as trailing ones: a copied-through
    // `--watch` never exits (180s gate timeout on green code) and `--inspect-brk`
    // waits for a debugger. Only loaders/conditions may pass; anything else
    // falls back to the full historical command.
    const prefixValueFlags = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader', '--conditions']);
    const prefixBooleanFlags = new Set(['--no-warnings', '--enable-source-maps', '--experimental-vm-modules', '--experimental-strip-types']);
    for (let index = 0; index < prefix.length - 1; index += 1) {
      const word = prefix[index];
      if (!word.startsWith('-')) continue;
      if (word.includes('=')) {
        if (!prefixValueFlags.has(word.split('=')[0])) return null;
        continue;
      }
      if (prefixValueFlags.has(word)) { index += 1; continue; }
      if (prefixBooleanFlags.has(word)) continue;
      return null; // --watch, --inspect*, anything unrecognized: full-suite fallback
    }
    const trailing = words.slice(testIndex + 1);
    const trailingFlags = [];
    const flagsWithValues = new Set([
      '--test-reporter', '--test-reporter-destination', '--test-name-pattern',
      '--test-shard', '--test-timeout', '--test-concurrency',
    ]);
    // --watch deliberately absent: a watch-mode targeted run never exits and
    // burns the whole gate timeout; the full-suite fallback keeps the
    // project's historical behavior for such scripts.
    const booleanFlags = new Set([
      '--test-only', '--test-force-exit', '--test-update-snapshots',
      '--experimental-test-coverage',
    ]);
    for (let index = 0; index < trailing.length; index += 1) {
      const word = trailing[index];
      if (!word.startsWith('--')) continue; // positional full-suite path/glob: replace it
      if (word.includes('=')) { trailingFlags.push(word); continue; }
      if (flagsWithValues.has(word)) {
        const value = trailing[index + 1];
        if (!value || value.startsWith('--')) return null;
        trailingFlags.push(word, value);
        index += 1;
        continue;
      }
      if (booleanFlags.has(word)) { trailingFlags.push(word); continue; }
      return null; // unknown option shape: full-suite fallback is safer
    }
    return { cmd: process.execPath, args: [...prefix, ...trailingFlags, ...files], kind: 'node-test' };
  }
  if (['vitest', 'jest', 'mocha', 'ava', 'tap'].includes(executable)
      || (executable === 'bun' && words[1] === 'test')
      || (executable === 'tsx' && words.includes('--test'))) {
    // If scripts.test already pins a positional path/glob (e.g. "jest tests/",
    // "vitest run src"), appending files runs the UNION — the runner's multi-
    // pattern match is an OR, so the full suite still runs every time. Refuse and
    // fall back to the historical full-suite command, exactly as the node-test
    // branch does. Skip the runner's own subcommand token (bun `test`, vitest `run`).
    let scanFrom = 1;
    if (executable === 'bun') scanFrom = 2;
    else if (executable === 'vitest' && words[1] === 'run') scanFrom = 2;
    const hasPositionalPath = words.slice(scanFrom).some((w) => !w.startsWith('-'));
    if (hasPositionalPath) return null;
    return { cmd: 'npm', args: ['test', '--silent', '--', ...files], kind: 'npm-passthrough' };
  }
  return null;
}
