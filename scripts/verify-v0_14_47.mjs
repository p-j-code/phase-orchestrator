// v0.14.47 verifier — docs catch-up (NEW_FEATURES / TELEGRAM_BOT / MODEL_ROUTING
// current to 0.14.46, VitePress-safe). Content + hazard checks; no runtime code.
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

// Vue-hazard scan: bare <tag> outside code fences / inline code
function vueHazards(md) {
  const lines = md.split('\n'); let fence = false; const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.trimStart().startsWith('```')) { fence = !fence; continue; }
    if (fence) continue;
    const re = /<([a-zA-Z][a-zA-Z0-9_-]*)/g; let m;
    while ((m = re.exec(ln))) { if (ln.slice(0, m.index).split('`').length % 2 === 1) hits.push(`${i + 1}:${m[0]}`); }
  }
  return hits;
}

console.log(chalk.bold('\n── v0.14.47 verifier ──\n'));
const nf = readSrc('docs/NEW_FEATURES.md');
const tb = readSrc('docs/TELEGRAM_BOT.md');
const mr = readSrc('docs/MODEL_ROUTING.md');

check('NEW_FEATURES covers the v0.14.34–.46 arc (spend, two-stage, until-clean, addbug, transient)',
  /\/spend/.test(nf) && /Two-stage full audits/.test(nf) && /♾ Until clean/.test(nf)
  && /\/addbug/.test(nf) && /Deferred transient retries/.test(nf) && /v0\.14\.46/.test(nf));
check('TELEGRAM_BOT bumped to v0.14.46 and documents /spend + /addbug + audit menu',
  /Current as of v0\.14\.46\./.test(tb) && /\/spend/.test(tb) && /\/addbug/.test(tb)
  && /♾ Until clean/.test(tb));
check('MODEL_ROUTING corrects stale claims (haiku retired, prefer_top false, escalation_tasks, audit-scan)',
  /Haiku is fully retired/.test(mr) && /prefer_top_for_critical` is retired/.test(mr)
  && /escalation_tasks/.test(mr) && /audit-scan/.test(mr)
  && !/never_use_haiku_for_dev` and `never_use_haiku_for_reviews` \(defaults are true\)/.test(mr));
check('MODEL_ROUTING config example no longer shows prefer_top_for_critical: true',
  !/"prefer_top_for_critical": true/.test(mr));
check('no Vue-component hazards introduced in any of the three docs',
  vueHazards(nf).length === 0 && vueHazards(tb).length === 0 && vueHazards(mr).length === 0,
  JSON.stringify({ nf: vueHazards(nf), tb: vueHazards(tb), mr: vueHazards(mr) }));
check('package.json version is 0.14.47', JSON.parse(readSrc('package.json')).version === '0.14.47');

console.log('');
if (failed === 0) { console.log(chalk.green.bold(`✓ All ${passed} checks passed.`)); process.exit(0); }
console.log(chalk.red.bold(`✗ ${failed} failed, ${passed} passed.`)); process.exit(1);
