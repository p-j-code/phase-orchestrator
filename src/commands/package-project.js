// Package Project — creates a portable zip of a project's deliverable state.
// Excludes node_modules, .env, .git, .DS_Store, build artifacts, logs.
// Includes: workspace/ source, .guide/, project.json, inputs/, outputs/.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { getProject } from '../state.js';
import { resolve as resolveConfig } from '../config-resolver.js';
import { isGitRepo } from '../lib/git.js';
import { runShipGate } from '../lib/ship-gate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');
const OUTPUTS_DIR = path.join(REPO_ROOT, 'outputs');

// Patterns to exclude from the zip (passed to `zip -x`)
const EXCLUDE_PATTERNS = [
  '*/node_modules/*',
  '*/dist/*',
  '*/build/*',
  '*/.next/*',
  '*/.cache/*',
  '*/coverage/*',
  '*/.env',
  '*/.env.local',
  '*/.env.*.local',
  '*/.DS_Store',
  '*/.git/objects/pack/*',  // keep git history but skip large packfiles
  '*/npm-debug.log',
  '*/yarn-error.log',
  '*/*.tsbuildinfo',
];

// Optional: also strip .git entirely (useful for shipping outside the team)
const STRIP_GIT_PATTERNS = ['*/.git/*'];

const EXCLUDED_TREE_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.cache', 'coverage']);

/**
 * Reject symlinks before invoking Info-ZIP. `zip -r` follows links by default,
 * so an otherwise innocent-looking workspace link could copy ~/.ssh, an .env,
 * or any other host file into a downloadable release.  The realpath check is a
 * second defence for unusual filesystem layouts; `-y` below closes the
 * scan-to-zip race by storing, rather than following, a link introduced later.
 */
export async function assertPackageTreeSafe(root, { includeGit = true } = {}) {
  const resolvedRoot = path.resolve(root);
  const rootStat = await fs.lstat(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    const err = new Error(`Package root must be a real directory: ${resolvedRoot}`);
    err.code = 'PACKAGE_UNSAFE_PATH';
    throw err;
  }
  const realRoot = await fs.realpath(resolvedRoot);

  const walk = async (dir, relativeDir = '') => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      const relPosix = rel.split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (EXCLUDED_TREE_DIRS.has(entry.name)) continue;
        if (!includeGit && (relPosix === '.git' || relPosix.startsWith('.git/'))) continue;
        if (relPosix === '.git/objects/pack') continue;
      }

      const full = path.join(dir, entry.name);
      const st = await fs.lstat(full);
      if (st.isSymbolicLink()) {
        const err = new Error(`Refusing to package symbolic link: ${relPosix}`);
        err.code = 'PACKAGE_UNSAFE_SYMLINK';
        err.path = relPosix;
        throw err;
      }
      const real = await fs.realpath(full);
      if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) {
        const err = new Error(`Refusing package path outside project root: ${relPosix}`);
        err.code = 'PACKAGE_UNSAFE_PATH';
        err.path = relPosix;
        throw err;
      }
      if (st.isDirectory()) await walk(full, rel);
    }
  };

  await walk(resolvedRoot);
  return { root: realRoot, safe: true };
}

export async function packageProject({ projectName, includeGit = true, outputDir = null, quiet = false, skipGate = false }) {
  const project = getProject(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const projDir = path.join(PROJECTS_DIR, projectName);
  if (!fsSync.existsSync(projDir)) {
    throw new Error(`Project directory missing: ${projDir}`);
  }

  // ── Ship gate (phase-44): same deterministic scan as /ship, run before we
  // zip a deliverable. Blockers throw unless --skip-gate; enabled:false or a
  // non-git workspace (nothing to diff) bypasses. ──
  const workspaceDir = path.join(projDir, 'workspace');
  if (skipGate) {
    if (!quiet) console.warn(chalk.bold.yellow(`  ⚠ SHIP GATE SKIPPED (--skip-gate) for ${projectName} — secret/dependency/license scan did NOT run.`));
  } else {
    const cfg = await resolveConfig({ project: projectName, task: 'dev-execution' });
    if (cfg.ship_gate?.enabled !== false && (await isGitRepo(workspaceDir))) {
      const gate = await runShipGate({
        workspaceDir, projDir, cfg,
        source: project.git_branch || 'HEAD', target: 'main',
      });
      if (!quiet) for (const w of gate.warnings) console.warn(chalk.yellow(`  ⚠ ship gate: ${w.message}`));
      if (!gate.ok) {
        throw new Error(
          `Ship gate blocked packaging of ${projectName} (${gate.blockers.length} blocker(s)). ` +
          `See ${path.relative(REPO_ROOT, gate.reportPath)}\n  ` +
          gate.blockers.map((b) => `[${b.kind}] ${b.message}`).join('\n  ') +
          `\n  Override with --skip-gate once reviewed.`,
        );
      }
    }
  }

  // Ensure outputs/ exists
  const outDir = outputDir || OUTPUTS_DIR;
  await fs.mkdir(outDir, { recursive: true });

  // Build output filename
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${projectName}-${timestamp}.zip`;
  const outputPath = path.join(outDir, filename);
  const tempOutputPath = path.join(outDir, `.${filename}.${process.pid}.${Date.now()}.partial.zip`);

  try {
    await fs.access(outputPath);
    throw new Error(`Release archive already exists: ${outputPath}`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  await assertPackageTreeSafe(projDir, { includeGit });

  // Build zip command
  const patterns = [...EXCLUDE_PATTERNS];
  if (!includeGit) patterns.push(...STRIP_GIT_PATTERNS);

  const args = [
    '-r',                // recursive
    '-q',                // quiet (we'll report ourselves)
    '-y',                // never follow a symlink introduced after preflight
    tempOutputPath,
    projectName,         // the directory to zip (relative to PROJECTS_DIR)
    '-x',                // exclude patterns follow
    ...patterns,
  ];

  if (!quiet) console.log(chalk.cyan(`Packaging ${projectName} → ${path.relative(REPO_ROOT, outputPath)}…`));

  let stat;
  let published = false;
  try {
    await runZip(args, PROJECTS_DIR);
    // A link introduced during the zip is stored as a link because of -y, not
    // dereferenced. Re-scan before publishing and fail closed if it remains.
    await assertPackageTreeSafe(projDir, { includeGit });
    await fs.rename(tempOutputPath, outputPath);
    published = true;
    stat = await fs.stat(outputPath);
  } catch (err) {
    await fs.rm(tempOutputPath, { force: true }).catch(() => {});
    if (published) await fs.rm(outputPath, { force: true }).catch(() => {});
    throw err;
  }
  const sizeMB = (stat.size / 1024 / 1024).toFixed(2);

  if (!quiet) {
    console.log(chalk.green(`✓ Created ${filename} (${sizeMB} MB)`));
    console.log(chalk.dim(`  Path: ${outputPath}`));
    console.log(chalk.dim(`  Excludes: node_modules, dist, build, .next, .env*, .DS_Store, large git packs${!includeGit ? ', .git/' : ''}`));
  }

  return { path: outputPath, filename, sizeBytes: stat.size };
}

function runZip(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('zip', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('exit', (code) => {
      // zip exit codes: 0 = OK, 12 = nothing to do (also OK)
      if (code === 0 || code === 12) return resolve();
      reject(new Error(`zip failed with code ${code}: ${stderr.slice(0, 200)}`));
    });
    child.on('error', (err) => reject(new Error(`zip command not found: ${err.message}. Install with: brew install zip (Mac) or apt install zip (Linux)`)));
  });
}
