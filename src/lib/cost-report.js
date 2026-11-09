// Cost report (v0.14.34) — ACTUAL spend from the calls table, grouped by
// task + model. This is the measurement half of model-cost optimization:
// /predict estimates upcoming work; /spend shows where money actually went,
// so routing changes (incremental audits, escalation rules) can be ranked by
// data instead of intuition.
//
// Pure read — never writes. Degrades gracefully on NULL cost_usd rows (calls
// recorded before cost capture, or errored calls): they're counted in `n` but
// contribute 0 to usd, and the report says how many rows lacked cost data.
//
// The DB layer is lazy-imported inside costReport() (same pattern as
// src/pipeline.js) so module load — and the render helpers below — stay
// dependency-free. Verifiers can test renderCostReport/shortModel without
// better-sqlite3 being buildable.
//
// P1: the actual SQL moved to state.js's getSpendReport() — the one shared
// aggregation helper used by both this CLI/Telegram/Discord path and
// src/web-ui.js, so cache_hit_pct math isn't duplicated across the two.

/**
 * Query spend grouped by task+model over a trailing window. Thin wrapper
 * around state.js's getSpendReport() — see that function for the shape.
 *
 * @param {object} [o]
 * @param {number} [o.days=30]      trailing window in days (clamped 1..365)
 * @param {string} [o.project=null] limit to one project (null = all)
 * @returns {Promise<{
 *   days: number, project: string|null,
 *   rows: Array<{task:string, model:string, n:number, errors:number, usd:number,
 *                input_tokens:number, output_tokens:number, cache_read_tokens:number,
 *                cache_creation_tokens:number, cache_hit_pct:number}>,
 *   byProject: Array<{project:string, n:number, usd:number}>,
 *   totals: { n:number, usd:number, errors:number, uncosted:number, cache_hit_pct:number },
 * }>}
 */
export async function costReport({ days = 30, project = null } = {}) {
  const { getSpendReport } = await import('../state.js');
  return getSpendReport({ days, project });
}

const fmtUsd = (v) => `$${(v || 0).toFixed(2)}`;
const fmtK = (v) => {
  const n = v || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
};

/** Shorten a model id for narrow displays: claude-opus-4-8 → opus-4-8. */
export function shortModel(model) {
  return String(model || '?').replace(/^claude-/, '');
}

/**
 * Render the report as Telegram-safe plain text (caller wraps in <pre> and
 * escapes — this function produces NO HTML). Designed for a phone screen:
 * the task+model table is capped, tokens compacted to k/M.
 *
 * @param {ReturnType<typeof costReport>} report
 * @param {object} [o]
 * @param {number} [o.maxRows=12] cap on task+model rows shown
 */
export function renderCostReport(report, { maxRows = 12 } = {}) {
  const { rows, byProject, totals, days, project } = report;
  const lines = [];

  const scope = project ? `project ${project}` : 'all projects';
  lines.push(`Spend — last ${days}d — ${scope}`);
  lines.push(`Total: ${fmtUsd(totals.usd)} across ${totals.n} call(s), ${totals.errors} error(s), cache-hit ${totals.cache_hit_pct ?? 0}%`);
  if (totals.uncosted > 0) {
    lines.push(`(${totals.uncosted} call(s) had no cost data — excluded from $)`);
  }
  lines.push('');

  if (rows.length === 0) {
    lines.push('No calls in this window.');
    return lines.join('\n');
  }

  lines.push('By task × model:');
  const shown = rows.slice(0, maxRows);
  for (const r of shown) {
    const err = r.errors ? ` ${r.errors}err` : '';
    lines.push(
      `${fmtUsd(r.usd).padStart(8)}  ${r.task} · ${shortModel(r.model)}  (${r.n}×${err}, in ${fmtK(r.input_tokens)} / out ${fmtK(r.output_tokens)} / cache ${fmtK(r.cache_read_tokens)} / hit ${r.cache_hit_pct ?? 0}%)`,
    );
  }
  if (rows.length > shown.length) {
    const restUsd = rows.slice(maxRows).reduce((s, r) => s + (r.usd || 0), 0);
    lines.push(`${fmtUsd(restUsd).padStart(8)}  …${rows.length - shown.length} more row(s)`);
  }

  if (!project && byProject.length > 1) {
    lines.push('');
    lines.push('By project:');
    for (const p of byProject.slice(0, 8)) {
      lines.push(`${fmtUsd(p.usd).padStart(8)}  ${p.project} (${p.n}×)`);
    }
  }

  return lines.join('\n');
}
