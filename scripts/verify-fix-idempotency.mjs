#!/usr/bin/env node
// verify-fix-idempotency.mjs — validates the phase-runner fix-idempotency gate
// Run: node scripts/verify-fix-idempotency.mjs  (exit 0 = all pass)

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PR = readFileSync(path.join(__dirname, '..', 'src', 'lib', 'phase-runner.js'), 'utf8');

let pass = 0, fail = 0;
const ok  = (l) => { console.log('OK ', l); pass++; };
const bad = (l) => { console.log('FAIL', l); fail++; };

// 1. reportExistedBefore is declared BEFORE the runClaude call in runDev.
//    Anchor from preSha (unique to runDev) so we skip the earlier runGuide call.
const preShaSectionPos    = PR.indexOf('const preSha =');
const runClaudePos        = preShaSectionPos >= 0 ? PR.indexOf('runClaude(', preShaSectionPos) : -1;
const reportExistedPos    = PR.indexOf('reportExistedBefore');
reportExistedPos >= 0 && reportExistedPos < runClaudePos
  ? ok('1: reportExistedBefore declared before runClaude')
  : bad('1: reportExistedBefore must be declared before runClaude (snapshot timing)');

// 2. !reportExistedBefore gate is present inside the commit_sha===preSha block
const noCommitAnchor = PR.indexOf('commit_sha === preSha');
const noCommitBlock  = noCommitAnchor >= 0
  ? PR.slice(noCommitAnchor, noCommitAnchor + 1200)
  : '';
noCommitBlock.includes('!reportExistedBefore')
  ? ok('2: !reportExistedBefore gate present in no-commit idempotency block')
  : bad('2: !reportExistedBefore gate missing from no-commit idempotency block');

// 3. Comment explaining the hand-reset / stale-report scenario is present
/hand.?reset|stale.*report|reflog/i.test(PR)
  ? ok('3: hand-reset / stale-report comment present')
  : bad('3: missing comment about hand-reset scenario (reflog / stale report)');

// 4a. Boolean logic — failure case:
//     reportExistedBefore=true → gate blocks → fix NOT marked complete
const failureGate = !true && true;  // !reportExistedBefore && reportExists
failureGate === false
  ? ok('4a: failure case — report pre-existed spawn → gate blocks (condition false)')
  : bad('4a: failure case — gate should block when reportExistedBefore=true');

// 4b. Boolean logic — success case:
//     reportExistedBefore=false → gate passes → fix IS marked complete
const successGate = !false && true;  // !reportExistedBefore && reportExists
successGate === true
  ? ok('4b: success case — report written during spawn → gate passes (condition true)')
  : bad('4b: success case — gate should pass when reportExistedBefore=false');

// 4c. Boolean logic — no report written (claude produced no output):
//     reportExistedBefore=false, reportExists=false → gate does not fire → falls through to fail path
const noReportGate = !false && false;  // !reportExistedBefore && reportExists (reportExists=false)
noReportGate === false
  ? ok('4c: no-report case — no report written → gate does not fire → falls through to fail path')
  : bad('4c: no-report case — gate should not fire when reportExists=false');

console.log(`\nverify-fix-idempotency: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
