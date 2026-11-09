// Req-promote — batch promote refined requirements from one project's inbox
// into another project's raw-thoughts.md. The Telegram/CLI fast lane that
// brings requirements ergonomics up to parity with /bug_promote.
//
// Mirrors src/commands/bugs-inbox.js#performBugPromote but for the req
// pipeline: SQL filter on (project, scope, status) → append blocks to
// destination project's raw-thoughts.md → mark promoted in DB.
//
// v0.14.11.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listRequirements, updateRequirement, getProject, getDb,
} from '../state.js';
import { rawThoughtsPath } from '../lib/guide-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

/**
 * Promote refined requirements from `inboxProject` (typically '_inbox' or any
 * real project) into `destinationProject`'s raw-thoughts.md. Selects items by
 * `scope` (default 'now'). Items with status 'promoted' or 'dropped' are
 * skipped. Returns { promoted, ids, destinationPath, tag, items }.
 *
 * `autoScope`: if true, also flips any matching items with scope='unassigned'
 * to scope=<scope> before the filter — useful for the Telegram fast lane
 * where the user hasn't manually triaged each item.
 *
 * Throws if `destinationProject` doesn't exist in the projects table, or if
 * no requirements would be promoted.
 */
export async function performReqPromote({
  inboxProject,
  destinationProject,
  scope = 'now',
  autoScope = false,
  statusFilter = null, // null = all eligible; or 'refined' / 'inbox'
} = {}) {
  if (!inboxProject) throw new Error('inboxProject is required');
  if (!destinationProject) throw new Error('destinationProject is required');

  // _inbox is the only virtual project — it never exists in the projects table.
  // Every other inboxProject and ALL destinationProjects must exist.
  if (destinationProject === '_inbox') {
    throw new Error('destinationProject cannot be _inbox (it has no raw-thoughts.md)');
  }
  if (!getProject(destinationProject)) {
    throw new Error(`destinationProject not found: ${destinationProject}`);
  }

  // Optional auto-scope: flip unassigned → scope. Useful for one-tap promote.
  if (autoScope) {
    const db = getDb();
    db.prepare(
      `UPDATE requirements
         SET scope = ?, updated_at = ?
         WHERE project = ?
           AND scope = 'unassigned'
           AND status IN ('inbox', 'refined')`,
    ).run(scope, new Date().toISOString(), inboxProject);
  }

  // Filter promotable items
  let items = listRequirements({ project: inboxProject, scope });
  items = items.filter((r) => r.status !== 'promoted' && r.status !== 'dropped');
  if (statusFilter) items = items.filter((r) => r.status === statusFilter);

  if (!items.length) {
    throw new Error(
      `No promotable requirements in ${inboxProject} with scope=${scope}`
      + (statusFilter ? ` and status=${statusFilter}` : '')
      + '. Run `npm run req -- refine ' + inboxProject + '` first, '
      + 'or set scope=now on items with `set <id> scope now`.',
    );
  }

  const projDir = path.join(PROJECTS_DIR, destinationProject);
  const dest = rawThoughtsPath(projDir);
  await fs.mkdir(path.dirname(dest), { recursive: true });

  const timestamp = new Date().toISOString();
  const tag = `req-promote-${timestamp.replace(/[:.]/g, '-')}`;
  const fromLabel = inboxProject === destinationProject
    ? `${destinationProject} inbox`
    : `${inboxProject} → ${destinationProject}`;

  const lines = [
    '',
    `<!-- promoted from ${fromLabel} at ${timestamp} (scope=${scope}, ${items.length} items) -->`,
    `## Promoted requirements (${scope}) — ${timestamp.slice(0, 10)}`,
    '',
  ];

  for (const r of items) {
    let block;
    if (r.refined_text) {
      try {
        const obj = JSON.parse(r.refined_text);
        block = [
          `### ${obj.title || '(no title)'}`,
          '',
          obj.what || '',
          '',
          obj.why ? `_Why: ${obj.why}_` : '',
          '',
          obj.touches ? `**Touches:** ${obj.touches}` : '',
          (obj.open_questions && obj.open_questions.length)
            ? '\n**Open questions:**\n' + obj.open_questions.map((q) => `- ${q}`).join('\n')
            : '',
          '',
          `_Raw: ${r.raw_text.replace(/\n/g, ' ')}_`,
          `_(req #${r.id}, priority ${r.priority})_`,
          '',
        ].filter((l) => l !== '').join('\n');
      } catch {
        block = `### Requirement #${r.id}\n${r.raw_text}\n_(priority ${r.priority})_`;
      }
    } else {
      block = `### Requirement #${r.id}\n${r.raw_text}\n_(priority ${r.priority}, not yet refined)_`;
    }
    lines.push(block);
    lines.push('');
  }

  await fs.appendFile(dest, lines.join('\n'));

  // Mark promoted
  for (const r of items) {
    updateRequirement(r.id, { status: 'promoted', promoted_to: tag });
  }

  return {
    promoted: items.length,
    ids: items.map((r) => r.id),
    destinationPath: dest,
    tag,
    items,
  };
}

/**
 * Remember the last destination project used for a given inbox, so the
 * Telegram fast-lane can offer it as a default. Stored as a simple row in
 * the kv-style `inbox_destinations` table, created lazily.
 */
export function rememberInboxDestination(inboxProject, destinationProject, userId = null) {
  const db = getDb();
  // Lazy table create — idempotent, no migration step needed for this minor
  // feature. If the orchestrator wants to formalize it later, move into a
  // proper migrations file.
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_destinations (
    inbox_project TEXT PRIMARY KEY,
    destination_project TEXT NOT NULL,
    set_by INTEGER,
    set_at TEXT NOT NULL
  )`);
  db.prepare(
    `INSERT INTO inbox_destinations (inbox_project, destination_project, set_by, set_at)
       VALUES (?, ?, ?, ?)
     ON CONFLICT(inbox_project) DO UPDATE SET
       destination_project = excluded.destination_project,
       set_by = excluded.set_by,
       set_at = excluded.set_at`,
  ).run(inboxProject, destinationProject, userId, new Date().toISOString());
}

export function getLastInboxDestination(inboxProject) {
  const db = getDb();
  try {
    const row = db.prepare(
      `SELECT destination_project FROM inbox_destinations WHERE inbox_project = ?`,
    ).get(inboxProject);
    return row?.destination_project || null;
  } catch (err) {
    // Table doesn't exist yet → no remembered destination
    if (/no such table/i.test(err.message)) return null;
    throw err;
  }
}
