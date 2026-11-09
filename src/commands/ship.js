// ship — promote develop → main for a project, fast-forward only.
//
// Behavior:
//   1. Verify project is git-managed (has git_branch)
//   2. Verify workspace is on the source branch (develop) and clean
//   3. Fast-forward target (main) to source (develop)
//   4. Push target to origin
//   5. Optional: create + push annotated tag (--tag vX.Y.Z)
//   6. Return to source branch
//
// Refuses to merge if not fast-forward. Refuses to ship if workspace dirty.
// If develop == main, reports no-op cleanly.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { getProject } from '../state.js';
import { resolve as resolveConfig } from '../config-resolver.js';
import { runShipGate } from '../lib/ship-gate.js';
import {
  fastForwardMerge, tagAndPush, workspaceStatus, getCurrentBranch,
  aheadBehind, lastCommitOneLine,
} from '../lib/git.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

/**
 * @returns {Promise<{
 *   ok: boolean, noop?: boolean, error?: string,
 *   from?: string, to?: string, source?: string, target?: string,
 *   tag?: string, fromSha?: string, toSha?: string
 * }>}
 */
export async function shipProject({ projectName, target = 'main', tag = null, skipGate = false, projectsDir = PROJECTS_DIR, cfg = null }) {
  const project = getProject(projectName);
  if (!project) return { ok: false, error: `Project not found: ${projectName}` };

  if (!project.git_branch) {
    return {
      ok: false,
      error: `Project '${projectName}' is not under git management.\n  Run: npm run migrate-git -- --project ${projectName}`,
    };
  }

  const source = project.git_branch;
  if (source === target) {
    return { ok: false, error: `Source and target are both '${source}'. Nothing to ship.` };
  }

  const workspaceDir = path.join(projectsDir, projectName, 'workspace');

  const status = await workspaceStatus(workspaceDir);
  if (!status.clean) {
    return {
      ok: false,
      error: `Workspace has ${status.dirty.length} uncommitted change(s). Commit, stash, or clean first.\n  ${status.dirty.slice(0, 5).join('\n  ')}`,
    };
  }

  const current = await getCurrentBranch(workspaceDir);
  if (current !== source) {
    return {
      ok: false,
      error: `Expected to be on '${source}' (project.git_branch) but workspace is on '${current}'.`,
    };
  }

  // Sync local source with origin first — otherwise ship would miss commits
  // that exist on origin/<source> but not in local. (Common case: orchestrator
  // pushed from NAS, then you triggered /ship from a different host with a
  // stale checkout.)
  const { syncWithRemote } = await import('../lib/git.js');
  const sync = await syncWithRemote(workspaceDir, { branch: source });
  if (!sync.ok) {
    return { ok: false, error: `Cannot ship — local ${source} is not in sync with origin:\n${sync.error}` };
  }
  if (sync.action === 'ahead-only') {
    return {
      ok: false,
      error:
        `Local ${source} is ${sync.ahead} commit(s) ahead of origin/${source}. ` +
        `Push them first so origin matches before shipping:\n  cd ${workspaceDir} && git push origin ${source}`,
    };
  }
  // action === 'pulled' | 'noop' | 'no-upstream' → safe to proceed

  // ── Ship gate (phase-44): deterministic secret/dependency/license scan ──
  // Runs AFTER clean/sync/branch checks, BEFORE the fast-forward merge, so a
  // blocker stops promotion before main ever moves. ship_gate.enabled:false or
  // --skip-gate bypasses; with either, the path below is byte-identical to the
  // pre-gate behavior (no config resolve, no gate side effects: no report, no
  // bug rows). `cfg` is an optional pre-resolved config injection point (tests);
  // production callers never pass it, so resolveConfig runs exactly as before.
  if (skipGate) {
    console.warn(chalk.bold.yellow(`\n  ⚠ SHIP GATE SKIPPED (--skip-gate) — secret/dependency/license scan did NOT run for ${projectName}.\n`));
  } else {
    const resolvedCfg = cfg || await resolveConfig({ project: projectName, task: 'dev-execution' });
    if (resolvedCfg.ship_gate?.enabled !== false) {
      const projDir = path.join(projectsDir, projectName);
      const gate = await runShipGate({ workspaceDir, projDir, cfg: resolvedCfg, source, target });
      for (const w of gate.warnings) console.warn(chalk.yellow(`  ⚠ ship gate: ${w.message}`));
      if (!gate.ok) {
        return {
          ok: false,
          error:
            `Ship gate blocked promotion of ${projectName} (${gate.blockers.length} blocker${gate.blockers.length === 1 ? '' : 's'}). ` +
            `main was NOT moved. See ${path.relative(projectsDir, gate.reportPath)}\n  ` +
            gate.blockers.map((b) => `[${b.kind}] ${b.message}`).join('\n  ') +
            `\n  Override with --skip-gate once reviewed.`,
        };
      }
      console.log(chalk.green(`  ✓ Ship gate passed${gate.warnings.length ? ` (${gate.warnings.length} warning(s))` : ''}`));
    }
  }

  console.log(chalk.bold.cyan(`\n═══ Ship ${projectName}: ${source} → ${target} ═══\n`));
  const lastCommit = await lastCommitOneLine(workspaceDir);
  if (lastCommit) console.log(chalk.dim(`  Latest on ${source}: ${lastCommit}`));

  // Do the FF merge
  const result = await fastForwardMerge(workspaceDir, { source, target });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  if (result.noop) {
    console.log(chalk.dim(`  ${target} is already at ${source}. Nothing to ship.`));
    return {
      ok: true, noop: true, source, target,
      fromSha: result.fromSha, toSha: result.toSha,
    };
  }

  console.log(chalk.green(`  ✓ Fast-forwarded ${target}: ${result.fromSha?.slice(0, 8)} → ${result.toSha?.slice(0, 8)}`));
  console.log(chalk.green(`  ✓ Pushed ${target} to origin`));

  // Optional tag
  let tagInfo = null;
  if (tag) {
    // Tag is created at the new HEAD of target, but we're back on source now.
    // tagAndPush tags at HEAD — switch briefly, tag, return.
    const { runGit } = await import('../lib/git.js');
    await runGit(workspaceDir, ['checkout', target]);
    const tr = await tagAndPush(workspaceDir, { tag, message: `Ship ${projectName} ${tag}` });
    await runGit(workspaceDir, ['checkout', source]);
    if (tr.ok) {
      console.log(chalk.green(`  ✓ Tagged ${tag} and pushed`));
      tagInfo = tag;
    } else {
      console.warn(chalk.yellow(`  ⚠ Tag failed: ${tr.error}`));
    }
  }

  console.log(chalk.bold.green(`\n✓ Shipped ${projectName}: ${source} → ${target}\n`));

  return {
    ok: true, source, target,
    fromSha: result.fromSha, toSha: result.toSha,
    tag: tagInfo,
  };
}
