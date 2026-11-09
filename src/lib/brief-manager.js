// Brief Manager — versioned brief snapshots and dev constraint injection.
//
// At plan creation time, brief.md is snapshotted into .guide/briefs/vN-ts.md
// and plan.json is stamped with brief_snapshot pointing to that frozen copy.
//
// All guide and dev calls during an active plan read the snapshot, so
// updating brief.md mid-dev (for the next sprint) never bleeds into
// in-progress phases. The live brief.md becomes the "next plan's brief".

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { briefPath, guideRoot } from './guide-paths.js';
import { sanitiseContent } from './sanitise-content.js';

// ─── Paths ──────────────────────────────────────────────────────────────────

export function briefVersionDir(projectDir) {
  return path.join(guideRoot(projectDir), 'briefs');
}

async function nextVersion(projectDir) {
  const dir = briefVersionDir(projectDir);
  try {
    const entries = await fs.readdir(dir);
    const versions = entries
      .map((e) => e.match(/^v(\d+)-/))
      .filter(Boolean)
      .map((m) => parseInt(m[1], 10));
    return versions.length ? Math.max(...versions) + 1 : 1;
  } catch {
    return 1;
  }
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

/**
 * Copy .guide/brief.md → .guide/briefs/vN-ts.md immediately after a new
 * plan.json is written. Returns { snapPath, relPath, version }.
 * relPath is relative to projectDir and goes into plan.json as brief_snapshot.
 */
export async function snapshotBrief(projectDir) {
  const content = await fs.readFile(briefPath(projectDir), 'utf-8');
  const dir = briefVersionDir(projectDir);
  await fs.mkdir(dir, { recursive: true });
  const version = await nextVersion(projectDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const snapPath = path.join(dir, `v${version}-${ts}.md`);
  await fs.writeFile(snapPath, content, 'utf-8');
  return { snapPath, relPath: path.relative(projectDir, snapPath), version };
}

// ─── Active brief ────────────────────────────────────────────────────────────

/**
 * Returns the brief path to use for the current plan.
 * Prefers plan.brief_snapshot (frozen at plan time) so mid-dev edits to
 * brief.md don't affect in-progress phases. Falls back to live brief.md.
 *
 * Falls back to live brief.md when the snapshot path doesn't exist on disk —
 * guards against a bad brief_snapshot (e.g. a bare name like "pk-vault-1"
 * written by the guide before the orchestrator overwrites it, left in place
 * if snapshotBrief later throws). Without this guard briefHash() would return
 * null for every call, causing the conformance gate to loop forever.
 */
export function activeBriefPath(projectDir, plan) {
  if (plan?.brief_snapshot) {
    const snapPath = path.join(projectDir, plan.brief_snapshot);
    try { fsSync.statSync(snapPath); return snapPath; } catch { /* bad/missing snapshot — fall through */ }
  }
  return briefPath(projectDir);
}

// ─── Constraint injection ────────────────────────────────────────────────────

/**
 * Extracts "Non-functional requirements", "Conventions to follow", and
 * "Gotchas" sections from the active brief. Returns a <brief_constraints>
 * XML block for injection into the dev system prompt, or null if no relevant
 * sections are found.
 */
export async function loadBriefConstraintsBlock(projectDir, plan) {
  const bPath = activeBriefPath(projectDir, plan);
  let content;
  try { content = await fs.readFile(bPath, 'utf-8'); } catch { return null; }
  if (!content?.trim()) return null;

  const TARGET = ['non-functional', 'conventions to follow', 'gotchas'];

  const lines = content.split('\n');
  const extracted = [];
  let inTarget = false;
  let targetDepth = 0;

  for (const line of lines) {
    const m = line.match(/^(#{1,4})\s+(.+)/);
    if (m) {
      const depth = m[1].length;
      const title = m[2].trim().toLowerCase();
      const isTarget = TARGET.some((s) => title.includes(s));
      if (isTarget) {
        inTarget = true;
        targetDepth = depth;
        extracted.push(line);
      } else if (inTarget && depth <= targetDepth) {
        inTarget = false;
      } else if (inTarget) {
        extracted.push(line);
      }
    } else if (inTarget) {
      extracted.push(line);
    }
  }

  while (extracted.length && !extracted[extracted.length - 1].trim()) extracted.pop();
  if (!extracted.length) return null;

  return `<brief_constraints>
These constraints from the project brief apply to every phase and fix — read before writing any code.

${sanitiseContent(extracted.join('\n'))}
</brief_constraints>`;
}

// ─── Content hash ─────────────────────────────────────────────────────────────

/**
 * SHA-256 of a file's UTF-8 contents, or null when the file is missing or
 * unreadable. Brief staleness/drift is decided by content, never mtime:
 *   - `cp -p` preserves the source mtime, so an mtime guard never fires;
 *   - atomic editor saves rename a new inode in with a fresh mtime even when
 *     the bytes are identical, producing a false positive;
 *   - `git stash` / `git checkout` flip mtimes in either direction.
 * A null return means "cannot compare" — callers treat it as not-stale rather
 * than throwing. node:crypto is built-in (no new dependency).
 */
export async function briefHash(p) {
  try {
    return createHash('sha256').update(await fs.readFile(p, 'utf-8')).digest('hex');
  } catch {
    return null;
  }
}

// ─── Drift check ─────────────────────────────────────────────────────────────

/**
 * Returns { updated: boolean, version: string } indicating whether the live
 * brief.md content differs from the plan's frozen snapshot. Compares SHA-256
 * content hashes (not mtime) so a same-bytes-different-mtime rewrite never
 * reports false drift and a content edit always does, regardless of mtimes.
 * Used to print an informational message at run start — never blocks dev.
 */
export async function checkBriefDrift(projectDir, plan) {
  if (!plan?.brief_snapshot) return { updated: false, version: null };
  const snapAbs = path.join(projectDir, plan.brief_snapshot);
  const vMatch = path.basename(plan.brief_snapshot).match(/^(v\d+)-/);
  const version = vMatch ? vMatch[1] : 'snapshot';
  const [liveHash, snapHash] = await Promise.all([
    briefHash(briefPath(projectDir)),
    briefHash(snapAbs),
  ]);
  // null hash = file missing/unreadable → cannot compare → report no drift.
  if (liveHash === null || snapHash === null) return { updated: false, version };
  return { updated: liveHash !== snapHash, version };
}
