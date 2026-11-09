// v0.14.40 verifier — flow-audit fixes: predict mirrors inline reality, CLI
// chain + single-task guide jobs fail honestly. 8 checks, source-asserted,
// runs anywhere.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import chalk from 'chalk';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0; let failed = 0;
function check(label, ok, details) {
  if (ok) { console.log(chalk.green('  OK  '), label); passed += 1; }
  else { console.log(chalk.red('  FAIL'), label, details ? chalk.dim(`— ${details}`) : ''); failed += 1; }
}
const readSrc = (rel) => { const p = resolve(REPO_ROOT, rel); if (!existsSync(p)) throw new Error(`Missing: ${rel}`); return readFileSync(p, 'utf8'); };

console.log(chalk.bold('\n── v0.14.40 verifier ──\n'));
const pd = readSrc('src/commands/predict.js');
const oc = readSrc('src/orchestrator.js');
const jr = readSrc('src/server/job-runner.js');

check('predict: fix-prompt-gen units only when inline_fix_prompts === false',
  /const fixPromptGenRuns = cfg\.fixes\?\.inline_fix_prompts === false;/.test(pd)
  && /fixPromptGenRuns \? await routeModel/.test(pd)
  && /if \(promptRouting\) \{[\s\S]{0,200}task: 'fix-prompt-gen'/.test(pd));
check('predict: phase-prompt-gen units only when inline_phase_prompts === false',
  /const phasePromptGenRuns = cfg\.phases\?\.inline_phase_prompts === false;/.test(pd)
  && /phasePromptGenRuns \? await routeModel/.test(pd)
  && /if \(promptRouting\) \{[\s\S]{0,200}task: 'phase-prompt-gen'/.test(pd));
check('predict: dev/fix execution units still unconditional',
  /task: 'dev-execution',\n\s+model: execRouting\.model/.test(pd)
  && /task: 'fix-execution',\n\s+model: execRouting\.model/.test(pd));

check('CLI audit: initial result checked, exits with the real reason',
  /const cliAudit = await runGuide\(\{ projectName, task: 'audit' \}\);/.test(oc)
  && /cliAudit\?\.is_error/.test(oc) && /process\.exit\(1\);/.test(oc));
check('CLI ×N chain: re-audit failure stops with "audit failed on round N"',
  /const cliReAudit = await runGuide/.test(oc)
  && /audit failed on round \$\{i \+ 1\}/.test(oc));

const singleTaskChecked = (jr.match(/const gRes = await runGuide\(\{ projectName: project, task/g) || []).length;
check('job-runner: all 5 single-task guide jobs capture + throw on is_error',
  singleTaskChecked === 5
  && /roadmap failed:/.test(jr) && /brief-author failed:/.test(jr)
  && /review failed:/.test(jr) && /handoff failed:/.test(jr)
  && /\$\{task\} failed:/.test(jr), `found ${singleTaskChecked}`);
check('no fire-and-forget runGuide remains in job-runner/orchestrator/pipeline',
  // v0.14.41: hardened — also catches one-line `try { await runGuide(...)` forms
  // (the pipeline brief-author call dodged the original ^\s*await pattern).
  ![jr, oc, readSrc('src/pipeline.js')].some((src) =>
    /(?:^\s*|\{\s*)await runGuide\(/m.test(src)));
check('package.json version is 0.14.40', JSON.parse(readSrc('package.json')).version === '0.14.40');

console.log('');
if (failed === 0) { console.log(chalk.green.bold(`✓ All ${passed} checks passed.`)); process.exit(0); }
console.log(chalk.red.bold(`✗ ${failed} failed, ${passed} passed.`)); process.exit(1);
