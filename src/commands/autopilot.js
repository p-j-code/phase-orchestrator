// autopilot command (Phase 85 — P7a).
//
// `ashmero autopilot approve <project> <action> [--nights N | --until <ts>]`
// writes a standing, ALWAYS-EXPIRING approval row (autopilot_approvals) that
// portfolio-autopilot.js execute() consumes as the sole gate for an autonomous
// overnight brief job. Default (neither flag): a single night (remaining_nights
// = 1). The core insert lives in src/lib/portfolio-autopilot.js grantApproval;
// this file only validates CLI input and prints the outcome.

import chalk from 'chalk';
import { grantApproval } from '../lib/portfolio-autopilot.js';

/**
 * Grant a standing approval for an autopilot action.
 *
 * @param {Object} opts
 * @param {string} opts.project
 * @param {string} opts.action           - e.g. 'brief'
 * @param {number|null} [opts.nights]     - nights valid (default 1)
 * @param {string|null} [opts.until]      - ISO/parseable expiry timestamp
 * @returns {Promise<Object>} the inserted approval descriptor
 */
export async function approveAutopilotAction({ project, action, nights = null, until = null } = {}) {
  if (!project || !action) {
    throw new Error('[autopilot approve] usage: autopilot approve <project> <action> [--nights N | --until <ts>]');
  }
  if (nights != null && until != null) {
    throw new Error('[autopilot approve] specify only one of --nights or --until, not both');
  }

  const row = grantApproval({ project, action, nights, until, scope: 'all' });

  if (row.expires_at) {
    console.log(chalk.green(
      `✓ Approved autopilot '${row.action}' for ${row.project} until ${row.expires_at} (approval #${row.id}).`,
    ));
  } else {
    const n = row.remaining_nights;
    console.log(chalk.green(
      `✓ Approved autopilot '${row.action}' for ${row.project} for ${n} night${n === 1 ? '' : 's'} (approval #${row.id}).`,
    ));
  }
  console.log(chalk.dim('  This approval expires — it is not a permanent bypass; re-run to renew.'));
  return row;
}
