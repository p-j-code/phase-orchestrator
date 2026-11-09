// Dashboard — generate a self-contained HTML page summarising orchestrator
// telemetry. Reads from SQLite, writes a single HTML file you can open in a
// browser or serve from a static file host.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import chalk from 'chalk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = path.join(REPO_ROOT, 'state', 'orchestrator.db');

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function generateDashboard({ outputPath = null } = {}) {
  const db = new Database(DB_PATH, { readonly: true });

  const projects = db.prepare('SELECT * FROM projects ORDER BY name').all();
  const calls = db.prepare(`
    SELECT project, task, model, cost_usd, started_at,
           input_tokens, output_tokens, duration_ms, is_error
    FROM calls ORDER BY started_at DESC LIMIT 500
  `).all();
  const recentCalls = calls.slice(0, 30);
  const phases = db.prepare(`
    SELECT project, n, title, status, model_used, commit_sha, started_at, completed_at
    FROM phases ORDER BY project, n
  `).all();

  // Aggregations
  const callsByProject = {};
  const callsByModel = {};
  const totalCost = calls.reduce((s, c) => s + (c.cost_usd || 0), 0);
  let errorCount = 0;
  for (const c of calls) {
    callsByProject[c.project || 'unknown'] = (callsByProject[c.project || 'unknown'] || 0) + 1;
    callsByModel[c.model || 'unknown'] = (callsByModel[c.model || 'unknown'] || 0) + 1;
    if (c.is_error) errorCount += 1;
  }

  const callsLast24h = calls.filter((c) => {
    const ts = new Date(c.started_at).getTime();
    return Date.now() - ts < 24 * 3600 * 1000;
  }).length;

  // Status counts
  const statusCounts = {};
  for (const p of projects) statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;

  // Cost per project
  const costByProject = {};
  for (const c of calls) {
    costByProject[c.project || 'unknown'] = (costByProject[c.project || 'unknown'] || 0) + (c.cost_usd || 0);
  }

  db.close();

  const generatedAt = new Date().toISOString();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Orchestrator Dashboard</title>
<style>
  :root {
    --bg: #0d1117; --fg: #e6edf3; --muted: #7d8590; --accent: #2f81f7;
    --success: #3fb950; --warn: #d29922; --danger: #f85149; --border: #30363d;
    --card: #161b22;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; background: var(--bg); color: var(--fg); padding: 24px; line-height: 1.5; }
  h1 { font-size: 28px; margin-bottom: 4px; }
  .meta { color: var(--muted); font-size: 14px; margin-bottom: 32px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 20px; }
  .card h3 { font-size: 12px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.5px; margin-bottom: 8px; }
  .card .stat { font-size: 32px; font-weight: 600; }
  .card .sub { color: var(--muted); font-size: 13px; margin-top: 4px; }
  section { margin-bottom: 32px; }
  section h2 { font-size: 18px; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; padding: 10px 12px; color: var(--muted); font-weight: 600; border-bottom: 1px solid var(--border); }
  td { padding: 10px 12px; border-bottom: 1px solid var(--border); }
  tr:hover td { background: rgba(255, 255, 255, 0.02); }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
  .badge.completed, .badge.success { background: rgba(63, 185, 80, 0.15); color: var(--success); }
  .badge.in-progress, .badge.running { background: rgba(47, 129, 247, 0.15); color: var(--accent); }
  .badge.planning, .badge.pending { background: rgba(125, 133, 144, 0.15); color: var(--muted); }
  .badge.paused, .badge.ready-for-qa { background: rgba(210, 153, 34, 0.15); color: var(--warn); }
  .badge.failed, .badge.error { background: rgba(248, 81, 73, 0.15); color: var(--danger); }
  .bar { display: flex; align-items: center; gap: 8px; }
  .bar-fill { background: var(--accent); height: 8px; border-radius: 2px; min-width: 2px; }
  code { font-family: 'SF Mono', Menlo, monospace; font-size: 12px; background: rgba(255, 255, 255, 0.05); padding: 2px 6px; border-radius: 3px; }
  .muted { color: var(--muted); }
  .mono { font-family: 'SF Mono', Menlo, monospace; font-size: 13px; }
  details { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-top: 16px; }
  details summary { cursor: pointer; color: var(--muted); }
</style>
</head>
<body>

<h1>Orchestrator Dashboard</h1>
<div class="meta">Generated ${esc(generatedAt)} · ${projects.length} projects · ${calls.length} calls tracked</div>

<div class="grid">
  <div class="card">
    <h3>Projects</h3>
    <div class="stat">${projects.length}</div>
    <div class="sub">${Object.entries(statusCounts).map(([s, n]) => `${esc(s)}: ${n}`).join(' · ') || '(none)'}</div>
  </div>
  <div class="card">
    <h3>Calls (lifetime)</h3>
    <div class="stat">${calls.length}</div>
    <div class="sub">${callsLast24h} in last 24h${errorCount > 0 ? ` · <span style="color: var(--danger)">${errorCount} errors</span>` : ''}</div>
  </div>
  <div class="card">
    <h3>Equivalent cost</h3>
    <div class="stat">$${totalCost.toFixed(2)}</div>
    <div class="sub">Display-only on Max plan</div>
  </div>
  <div class="card">
    <h3>Phases completed</h3>
    <div class="stat">${phases.filter((p) => p.status === 'completed').length}</div>
    <div class="sub">of ${phases.length} planned</div>
  </div>
</div>

<section>
  <h2>Projects</h2>
  <table>
    <thead>
      <tr><th>Project</th><th>Status</th><th>Progress</th><th>Calls</th><th>Cost</th><th>Tech</th></tr>
    </thead>
    <tbody>
      ${projects.map((p) => {
        const calls = callsByProject[p.name] || 0;
        const cost = costByProject[p.name] || 0;
        const progress = p.total_phases > 0 ? (p.current_phase / p.total_phases) * 100 : 0;
        return `<tr>
          <td><strong>${esc(p.name)}</strong></td>
          <td><span class="badge ${esc(p.status)}">${esc(p.status)}</span></td>
          <td><div class="bar"><div class="bar-fill" style="width: ${progress}px"></div><span class="mono">${p.current_phase}/${p.total_phases}</span></div></td>
          <td class="mono">${calls}</td>
          <td class="mono">$${cost.toFixed(2)}</td>
          <td><code>${esc(p.tech_stack || '-')}</code></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
</section>

<section>
  <h2>Model distribution</h2>
  <table>
    <thead><tr><th>Model</th><th>Calls</th><th>%</th></tr></thead>
    <tbody>
      ${Object.entries(callsByModel).sort((a, b) => b[1] - a[1]).map(([model, count]) => {
        const pct = ((count / calls.length) * 100).toFixed(1);
        return `<tr>
          <td class="mono">${esc(model)}</td>
          <td class="mono">${count}</td>
          <td><div class="bar"><div class="bar-fill" style="width: ${pct * 2}px"></div><span class="mono">${pct}%</span></div></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
</section>

<section>
  <h2>Recent calls (last 30)</h2>
  <table>
    <thead><tr><th>Time</th><th>Project</th><th>Task</th><th>Model</th><th>Cost</th><th>Tokens (in/out)</th><th>Duration</th></tr></thead>
    <tbody>
      ${recentCalls.map((c) => `<tr>
        <td class="muted mono">${esc(c.started_at?.slice(0, 19).replace('T', ' '))}</td>
        <td>${esc(c.project || '-')}</td>
        <td><code>${esc(c.task)}</code></td>
        <td class="mono" style="font-size: 12px">${esc(c.model || '-')}</td>
        <td class="mono">$${(c.cost_usd || 0).toFixed(3)}</td>
        <td class="muted mono">${esc(c.input_tokens || '-')}/${esc(c.output_tokens || '-')}</td>
        <td class="muted mono">${c.duration_ms ? (c.duration_ms / 1000).toFixed(1) + 's' : '-'}</td>
      </tr>`).join('')}
    </tbody>
  </table>
</section>

<details>
  <summary>About this dashboard</summary>
  <p class="muted" style="margin-top: 12px">
    Generated by <code>npm run dashboard</code>. Reads from <code>state/orchestrator.db</code>. Self-contained HTML — no external resources, safe to share or commit.
    Re-run to refresh. For real-time data, run <code>npm run dashboard -- --watch</code> (TBD) or open the SQLite directly.
  </p>
</details>

</body>
</html>`;

  const outPath = outputPath || path.join(REPO_ROOT, 'outputs', `dashboard-${Date.now()}.html`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, html);

  console.log(chalk.green(`✓ Dashboard written: ${path.relative(REPO_ROOT, outPath)}`));
  console.log(chalk.dim(`  Open with: open ${outPath}  (Mac)  or  xdg-open ${outPath}  (Linux)`));
  return outPath;
}
