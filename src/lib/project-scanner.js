import path from 'node:path';
import fs from 'node:fs/promises';
import { getDb } from '../state.js';
import { guideRoot } from './guide-paths.js';
import { runGit } from '../claude-runner.js';
const CODE_EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.vue', '.svelte']);

// Config filenames that signal framework / tooling choices
const CONFIG_SIGNALS = [
  'tsconfig.json', 'tsconfig.app.json',
  'vite.config.ts', 'vite.config.js',
  'next.config.js', 'next.config.ts', 'next.config.mjs',
  'nuxt.config.ts', 'nuxt.config.js',
  'tailwind.config.js', 'tailwind.config.ts',
  'postcss.config.js',
  'drizzle.config.ts', 'drizzle.config.js',
  'prisma/schema.prisma',
  'svelte.config.js',
  'astro.config.mjs',
  'remix.config.js',
  'wrangler.toml',
  'docker-compose.yml', 'Dockerfile',
  '.eslintrc.json', '.eslintrc.js', 'eslint.config.js',
  'vitest.config.ts', 'vitest.config.js',
  'jest.config.js', 'jest.config.ts',
];

// Directories that indicate a test suite
const TEST_DIR_SIGNALS = ['__tests__', 'test', 'tests', 'spec', 'e2e', 'cypress', 'playwright'];

// Entry-point candidates (tried in order)
const ENTRY_CANDIDATES = [
  'src/index.ts', 'src/index.js',
  'src/main.ts', 'src/main.js',
  'src/app.ts', 'src/app.js',
  'src/server.ts', 'src/server.js',
  'index.ts', 'index.js',
  'main.ts', 'main.js',
  'app.ts', 'app.js',
  'server.ts', 'server.js',
  'app/page.tsx', 'app/page.jsx',   // Next.js App Router
  'pages/index.tsx', 'pages/index.jsx',  // Next.js Pages Router
];

/**
 * @typedef {Object} ScanSnapshot
 * @property {string}   projectType
 * @property {string}   name
 * @property {string|null} description
 * @property {string[]} dependencies
 * @property {string[]} scripts
 * @property {boolean}  hasBin
 * @property {string|null} readmeExcerpt
 * @property {{ dirs: string[], fileCount: number }} srcStructure
 * @property {number}   completedPhases
 * @property {string[]} phaseTitles
 * @property {string|null} handoffExcerpt
 * @property {string|null} rawThoughtsExcerpt
 * // Enriched fields
 * @property {string[]} rootFiles          — files at workspace root
 * @property {string[]} rootDirs           — directory names at workspace root
 * @property {string[]} detectedConfigs    — config filenames that exist
 * @property {string|null} entryExcerpt    — first 500 chars of main entry file
 * @property {string|null} entryFile       — which entry file was found
 * @property {boolean}  hasTests
 * @property {string|null} testFramework   — 'vitest'|'jest'|'mocha'|'ava'|null
 * @property {string|null} gitLogExcerpt   — last 10 commits (oneline)
 * @property {string|null} envExampleExcerpt — first 300 chars of .env.example
 * @property {string|null} schemaExcerpt   — first 400 chars of prisma/schema.prisma or similar
 * @property {number}   openBugCount
 * @property {string}   scannedAt
 */

export async function scanProject(projectDir) {
  const snapshot = {
    projectType:          'unknown',
    name:                 path.basename(projectDir),
    description:          null,
    dependencies:         [],
    scripts:              [],
    hasBin:               false,
    readmeExcerpt:        null,
    srcStructure:         { dirs: [], fileCount: 0 },
    completedPhases:      0,
    phaseTitles:          [],
    handoffExcerpt:       null,
    rawThoughtsExcerpt:   null,
    // enriched
    rootFiles:            [],
    rootDirs:             [],
    detectedConfigs:      [],
    entryExcerpt:         null,
    entryFile:            null,
    hasTests:             false,
    testFramework:        null,
    gitLogExcerpt:        null,
    envExampleExcerpt:    null,
    schemaExcerpt:        null,
    openBugCount:         0,
    scannedAt:            new Date().toISOString(),
  };

  const workspaceDir = path.join(projectDir, 'workspace');

  // ── 1. package.json ────────────────────────────────────────────────────────
  try {
    const raw = await fs.readFile(path.join(workspaceDir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw);
    snapshot.name        = pkg.name || snapshot.name;
    snapshot.description = pkg.description || null;
    const deps = [
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
    ];
    snapshot.dependencies = [...new Set(deps)];
    snapshot.scripts      = Object.keys(pkg.scripts || {});
    snapshot.hasBin       = !!pkg.bin;
  } catch { /* best-effort */ }

  // ── 2. Root file listing ───────────────────────────────────────────────────
  try {
    const entries = await fs.readdir(workspaceDir, { withFileTypes: true });
    snapshot.rootFiles = entries
      .filter(e => e.isFile())
      .map(e => e.name)
      .slice(0, 40);                  // cap at 40 to keep the snapshot lean
    snapshot.rootDirs = entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .slice(0, 40);
  } catch { /* best-effort */ }

  // ── 3. Config file detection ───────────────────────────────────────────────
  const configChecks = await Promise.allSettled(
    CONFIG_SIGNALS.map(async (name) => {
      await fs.access(path.join(workspaceDir, name));
      return name;
    }),
  );
  snapshot.detectedConfigs = configChecks
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);

  // ── 4. src/ or app/ structure + test dir detection ─────────────────────────
  try {
    let srcDir = path.join(workspaceDir, 'src');
    let srcExists = false;
    try {
      const stat = await fs.stat(srcDir);
      srcExists = stat.isDirectory();
    } catch {
      srcDir = path.join(workspaceDir, 'app');
      try {
        const stat = await fs.stat(srcDir);
        srcExists = stat.isDirectory();
      } catch { /* neither */ }
    }

    if (srcExists) {
      const entries = await fs.readdir(srcDir, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
      snapshot.srcStructure.dirs = dirs;

      // Check if test dirs live inside src/
      if (dirs.some(d => TEST_DIR_SIGNALS.includes(d))) snapshot.hasTests = true;

      let fileCount = 0;
      for (const entry of entries) {
        if (entry.isFile() && CODE_EXTS.has(path.extname(entry.name))) fileCount++;
      }
      for (const dir of dirs) {
        try {
          const subEntries = await fs.readdir(path.join(srcDir, dir), { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isFile() && CODE_EXTS.has(path.extname(sub.name))) fileCount++;
          }
        } catch { /* best-effort */ }
      }
      snapshot.srcStructure.fileCount = fileCount;
    }
  } catch { /* best-effort */ }

  // Check root-level test directories
  if (!snapshot.hasTests) {
    snapshot.hasTests = snapshot.rootDirs.some(name => TEST_DIR_SIGNALS.includes(name));
  }

  // ── 5. Test framework detection ────────────────────────────────────────────
  const allDeps = snapshot.dependencies;
  if (allDeps.some(d => d.includes('vitest')))      snapshot.testFramework = 'vitest';
  else if (allDeps.some(d => d.includes('jest')))   snapshot.testFramework = 'jest';
  else if (allDeps.some(d => d.includes('mocha')))  snapshot.testFramework = 'mocha';
  else if (allDeps.some(d => d.includes('ava')))    snapshot.testFramework = 'ava';

  // ── 6. README ──────────────────────────────────────────────────────────────
  try {
    const readme = await fs.readFile(path.join(workspaceDir, 'README.md'), 'utf-8');
    snapshot.readmeExcerpt = readme.slice(0, 600);
  } catch { /* best-effort */ }

  // ── 7. Entry point peek ────────────────────────────────────────────────────
  for (const candidate of ENTRY_CANDIDATES) {
    try {
      const content = await fs.readFile(path.join(workspaceDir, candidate), 'utf-8');
      snapshot.entryFile    = candidate;
      snapshot.entryExcerpt = content.slice(0, 500);
      break;
    } catch { /* try next */ }
  }

  // ── 8. .env.example ───────────────────────────────────────────────────────
  for (const name of ['.env.example', '.env.sample', '.env.template']) {
    try {
      const content = await fs.readFile(path.join(workspaceDir, name), 'utf-8');
      snapshot.envExampleExcerpt = content.slice(0, 300);
      break;
    } catch { /* try next */ }
  }

  // ── 9. Schema file peek ────────────────────────────────────────────────────
  for (const rel of ['prisma/schema.prisma', 'src/db/schema.ts', 'src/schema.ts', 'drizzle/schema.ts']) {
    try {
      const content = await fs.readFile(path.join(workspaceDir, rel), 'utf-8');
      snapshot.schemaExcerpt = content.slice(0, 400);
      break;
    } catch { /* try next */ }
  }

  // ── 10. Git log ────────────────────────────────────────────────────────────
  snapshot.gitLogExcerpt = await runGit(['log', '--oneline', '-12'], { cwd: workspaceDir });

  // ── 11. DB phases ──────────────────────────────────────────────────────────
  try {
    const db = getDb();
    const projectKey = path.basename(projectDir);
    const countRow = db.prepare(
      `SELECT COUNT(*) as c FROM phases WHERE project = ? AND status = 'completed'`,
    ).get(projectKey);
    snapshot.completedPhases = countRow?.c ?? 0;
    const rows = db.prepare(
      `SELECT title FROM phases WHERE project = ? AND status = 'completed' ORDER BY n DESC LIMIT 5`,
    ).all(projectKey);
    snapshot.phaseTitles = rows.map(r => r.title).filter(Boolean);
  } catch { /* best-effort */ }

  // ── 12. Open bug count ─────────────────────────────────────────────────────
  try {
    const db = getDb();
    const projectKey = path.basename(projectDir);
    const bugRow = db.prepare(
      `SELECT COUNT(*) as c FROM bug_inbox WHERE project = ? AND status IN ('inbox', 'refined')`,
    ).get(projectKey);
    snapshot.openBugCount = bugRow?.c ?? 0;
  } catch { /* best-effort — bugs table may not exist */ }

  // ── 13. Handoff excerpt ────────────────────────────────────────────────────
  try {
    const handoffsDir = path.join(guideRoot(projectDir), 'handoffs');
    const files = await fs.readdir(handoffsDir);
    const handoffs = files
      .filter(f => f.startsWith('handoff-') && f.endsWith('.md'))
      .sort()
      .reverse();
    if (handoffs.length) {
      const content = await fs.readFile(path.join(handoffsDir, handoffs[0]), 'utf-8');
      snapshot.handoffExcerpt = content.slice(0, 400);
    }
  } catch { /* best-effort */ }

  // ── 14. raw-thoughts.md ───────────────────────────────────────────────────
  try {
    const content = await fs.readFile(
      path.join(guideRoot(projectDir), 'raw-thoughts.md'), 'utf-8',
    );
    snapshot.rawThoughtsExcerpt = content.slice(0, 400);
  } catch { /* best-effort */ }

  snapshot.projectType = classifyProject(snapshot);
  return snapshot;
}

const HYPHEN_SAFE = new Set(['react', 'vue', 'svelte', 'nuxt', 'angular', 'astro', 'remix']);
function _depMatches(d, sig) {
  return d === sig ||
    d.startsWith(sig + '/') ||
    d.startsWith('@' + sig + '/') ||
    (HYPHEN_SAFE.has(sig) && d.startsWith(sig + '-'));
}

export function classifyProject(snapshot) {
  const deps = snapshot.dependencies;
  const configs = snapshot.detectedConfigs || [];

  const FRONTEND_SIGNALS = ['react', 'vue', 'angular', 'svelte', 'next', 'nuxt', 'vite', 'astro', 'remix'];
  const BACKEND_SIGNALS  = ['express', 'fastify', 'hono', 'koa', '@nestjs/core', 'elysia'];
  const CLI_SIGNALS      = ['commander', 'yargs', 'oclif'];

  const hasFrontend = FRONTEND_SIGNALS.some(s => deps.some(d => _depMatches(d, s)))
    || configs.some(c => ['next.config.js', 'next.config.ts', 'next.config.mjs',
                           'nuxt.config.ts', 'svelte.config.js', 'astro.config.mjs'].includes(c));
  const hasBackend  = BACKEND_SIGNALS.some(s => deps.some(d => _depMatches(d, s)));
  const hasCli      = snapshot.hasBin || CLI_SIGNALS.some(s => deps.some(d => _depMatches(d, s)));

  if (hasCli && !hasFrontend) return 'cli';
  if (hasFrontend && !hasBackend) return 'frontend';
  if (hasBackend && !hasFrontend) return 'api';
  if (hasFrontend && hasBackend)  return 'fullstack';
  return 'unknown';
}
