// createProject — single source of truth for creating an orchestrator project.
// Used by both the CLI (`npm run new`) and the Telegram /new_project handler.
//
// Three modes, picked automatically based on inputs:
//
//   1. greenfield-with-git (url given, remote is empty / doesn't have refs)
//      → mkdir workspace, git init, initial commit (.gitignore), set remote,
//        create develop, push.
//
//   2. import-from-git (url given, remote has refs)
//      → git clone <url> into projects/<name>/workspace/, then run migrate-git
//        to land on the configured branch (default `develop`), creating it
//        from the cloned HEAD if it doesn't exist remotely.
//
//   3. no-git (url omitted, opt-out)
//      → mkdir empty workspace; the orchestrator will commit but not push.
//        Discouraged.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { upsertProject, getProject, setProjectGitConfig } from '../state.js';
import { remoteHasRefs, cloneRepo, isGitRepo, hasRemote, runGit } from '../lib/git.js';
import { migrateGit } from './migrate-git.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

/**
 * Infer a project slug from a git URL. Returns null if it can't.
 *   https://github.com/p-j-code/reelchain.git  → 'reelchain'
 *   git@github.com:p-j-code/reelchain.git       → 'reelchain'
 *   https://github.com/Some-User/Some_Repo      → 'some-repo'
 */
export function inferNameFromGitUrl(url) {
  if (!url || typeof url !== 'string') return null;
  // Strip trailing .git, query strings, trailing slashes
  let bare = url.replace(/\.git$/, '').replace(/[?#].*$/, '').replace(/\/$/, '');
  // Last path segment
  const seg = bare.split(/[\/:]/).pop();
  if (!seg) return null;
  // Normalize to lowercase alphanumeric + dashes
  const slug = seg.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return null;
  return slug;
}

/**
 * Basic git URL sanity check. Not bulletproof — git accepts many forms — but
 * catches obvious user errors before we shell out.
 */
export function looksLikeGitUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return (
    /^https?:\/\/.+/.test(url) ||         // https://github.com/...
    /^git:\/\/.+/.test(url) ||             // git:// protocol
    /^ssh:\/\/.+/.test(url) ||             // ssh:// protocol
    /^[\w.-]+@[\w.-]+:.+/.test(url)        // git@github.com:user/repo.git
  );
}

/**
 * @param {object} opts
 * @param {string} opts.name           Project slug (lowercase, alphanumeric + dashes)
 * @param {string} [opts.url]          Git remote URL (https or git@). Omit for --no-git.
 * @param {string} [opts.branch]       Working branch (default 'develop')
 * @param {string} [opts.tech]         Tech stack description (free text, for project.json)
 * @param {string} [opts.profile]      Profile name (e.g. 'nextjs-saas')
 * @param {boolean} [opts.noGit]       Explicit opt-out of git management
 * @param {(line: string) => void} [opts.onProgress]  Optional progress callback (for Telegram streaming)
 *
 * @returns {Promise<{
 *   ok: true,
 *   mode: 'imported' | 'greenfield' | 'no-git',
 *   name: string,
 *   projDir: string,
 *   workspaceDir: string,
 *   branch: string | null,
 *   remote: string | null,
 *   fileCount: number | null,
 *   pushed: boolean,
 * }>}
 */
export async function createProject({ name, url = null, branch = 'develop', tech = '', profile = null, noGit = false, onProgress = null } = {}) {
  const log = (line) => {
    if (onProgress) onProgress(line);
    // No console output here — caller (CLI handler) can also log via onProgress
  };

  // ── 1. Validate inputs ──────────────────────────────────────────────────
  if (!name || !/^[a-z0-9-]+$/.test(name)) {
    throw new Error(`Project name must be lowercase alphanumeric + dashes only: ${JSON.stringify(name)}`);
  }
  if (getProject(name)) {
    throw new Error(`Project already exists in SQLite: ${name}. Choose a different name or delete the existing row.`);
  }
  const projDir = path.join(PROJECTS_DIR, name);
  try {
    await fs.access(projDir);
    throw new Error(`Project directory already exists: ${projDir}. Choose a different name, or rm -rf to start fresh.`);
  } catch (e) {
    if (e.code !== 'ENOENT' && !String(e.message).includes('already exists')) {
      // ENOENT is what we want; other errors propagate
      if (String(e.message).includes('already exists')) throw e;
    } else if (e.code !== 'ENOENT') {
      throw e;
    }
  }
  if (!noGit && !url) {
    throw new Error('Provide a git URL (recommended) or pass noGit=true to opt out.');
  }
  if (url && !looksLikeGitUrl(url)) {
    throw new Error(`Doesn't look like a git URL: ${JSON.stringify(url)}`);
  }

  // ── 2. Probe remote (decide clone vs init+push) ─────────────────────────
  let mode; // 'imported' | 'greenfield' | 'no-git'
  if (noGit) {
    mode = 'no-git';
  } else {
    log(`Probing remote: ${url}`);
    const probe = await remoteHasRefs(url);
    if (!probe.ok) {
      throw new Error(
        `Cannot reach git remote: ${probe.error}\n` +
        `If this is a private repo, set up credentials (SSH key, or git credential helper) ` +
        `on this host first, then re-run.\n` +
        `If the repo doesn't exist yet on GitHub, create the empty repo first.`,
      );
    }
    mode = probe.hasRefs ? 'imported' : 'greenfield';
    log(probe.hasRefs ? `Remote has commits — will clone` : `Remote is empty — will init + push`);
  }

  // ── 3. Create project skeleton ──────────────────────────────────────────
  // For 'imported' mode we DON'T pre-create workspace/ — clone needs to make
  // the directory itself. We do create the other subdirs.
  await fs.mkdir(path.join(projDir, '.guide'), { recursive: true });
  await fs.mkdir(path.join(projDir, 'inputs'), { recursive: true });
  await fs.mkdir(path.join(projDir, 'outputs'), { recursive: true });

  const workspaceDir = path.join(projDir, 'workspace');
  let fileCount = null;

  if (mode === 'imported') {
    log(`Cloning ${url} → projects/${name}/workspace/ ...`);
    const cloneResult = await cloneRepo({ parentDir: projDir, targetName: 'workspace', url });
    if (!cloneResult.ok) {
      // Best-effort cleanup so a retry doesn't trip on "project dir exists"
      try { await fs.rm(projDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new Error(`Clone failed: ${cloneResult.error}`);
    }
    log(`Cloned. On branch: ${cloneResult.branch}`);
    // Count files (best-effort, doesn't fail the whole flow if it can't)
    try {
      const ls = await runGit(workspaceDir, ['ls-files']);
      if (ls.ok) fileCount = ls.stdout.split('\n').filter(Boolean).length;
    } catch { /* ignore */ }
  } else {
    // 'greenfield' or 'no-git' — workspace/ needs to exist as an empty dir
    await fs.mkdir(workspaceDir, { recursive: true });
  }

  // ── 4. project.json ─────────────────────────────────────────────────────
  // Build conditionally — never emit nulls for optional string fields, since
  // the project schema requires those fields to be strings when present
  // (writing `"profile": null` fails ajv validation; that bit us in v0.13.3).
  const projJson = {
    $schema_version: 1,
    name,
    created_at: new Date().toISOString(),
    current_phase: 0,
    total_phases: 0,
    guide_session_id: null,
    last_dev_session_id: null,
    status: 'planning',
    guide_layout_version: 2,
    overrides: {},
    metadata: {},
  };
  if (tech) projJson.tech_stack = tech;
  if (profile) projJson.profile = profile;
  if (!noGit && branch) projJson.git_branch = branch;
  if (!noGit && url) projJson.git_remote = url;
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify(projJson, null, 2) + '\n');

  // ── 5. SQLite ───────────────────────────────────────────────────────────
  upsertProject({ name, tech_stack: tech, profile });

  // ── 6. Wire git ─────────────────────────────────────────────────────────
  let pushed = false;
  let finalBranch = null;
  let finalRemote = null;

  if (mode === 'imported') {
    // We already have a git repo + remote (from clone). Run migrate-git to:
    //   - create develop from cloned HEAD if missing, switch to it
    //   - push develop, .gitignore housekeeping
    //   - record git_branch + git_remote in SQLite (it does this internally)
    log(`Setting up '${branch}' branch ...`);
    const mig = await migrateGit({ projectName: name, branch, remote: null, init: false });
    pushed = mig.pushed;
    finalBranch = mig.branch;
    finalRemote = mig.remote;
  } else if (mode === 'greenfield') {
    log(`Initializing fresh repo on '${branch}' ...`);
    const mig = await migrateGit({ projectName: name, branch, remote: url, init: true });
    pushed = mig.pushed;
    finalBranch = mig.branch;
    finalRemote = mig.remote;
  } else {
    // no-git: persist the explicit nulls
    setProjectGitConfig(name, { git_branch: null, git_remote: null });
    finalBranch = null;
    finalRemote = null;
  }

  return {
    ok: true,
    mode,
    name,
    projDir,
    workspaceDir,
    branch: finalBranch,
    remote: finalRemote,
    fileCount,
    pushed,
  };
}
