#!/usr/bin/env node
/**
 * run-discussion — non-interactive wrapper around the multi-agent discussion
 * engine, spawned detached by the chat control tool `start_discussion`.
 *
 * Usage:
 *   node scripts/run-discussion.mjs <project> --topic-file <path> [--mode auto|medium|max] [--auto-start]
 *
 * The CLI `discuss` command is interactive at the brief-append gate (readline),
 * so it can't be spawned detached. This wrapper calls runDiscussion() directly:
 *   - --auto-start: skips the gate — appends conclusions to the brief and
 *     starts the unattended dev pipeline (the operator confirmed in chat).
 *   - without it: conclusions are saved (DB + .guide/discussions/<id>/) and the
 *     no-tty gate collapses to "discard" — the brief stays unchanged; the
 *     operator reviews via the discussion_result chat tool and decides.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}

async function main() {
  const project = process.argv[2];
  const topicFile = argValue('--topic-file');
  const mode = argValue('--mode') || 'auto';
  const autoStart = process.argv.includes('--auto-start');
  if (!project || !topicFile) throw new Error('usage: run-discussion.mjs <project> --topic-file <path> [--mode m] [--auto-start]');

  const topic = (await fs.readFile(path.resolve(REPO_ROOT, topicFile), 'utf-8')).trim();
  if (!topic) throw new Error(`topic file is empty: ${topicFile}`);

  const { getProject } = await import('../src/state.js');
  if (!getProject(project)) throw new Error(`Project not found: ${project}`);

  const { runDiscussion } = await import('../src/lib/discussion-engine.js');
  const { discId, conclusion } = await runDiscussion({ projectName: project, topic, mode, autoStart });
  console.log(`[run-discussion] done — discussion #${discId}, ${conclusion?.top_recommendations?.length ?? 0} recommendation(s), autoStart=${autoStart}`);
}

main().catch((err) => {
  console.error(`[run-discussion] fatal: ${err.message}`);
  process.exit(1);
});
