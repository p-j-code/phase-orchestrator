// Error Classifier — pattern-match any Error (or string) to a recoverable category.
// Used by AutoHealer to pick the right recovery strategy.

export const ERROR_KINDS = {
  PROVIDER_LIMIT:    'provider-limit',
  NETWORK:          'network',
  GIT_DIVERGED:     'git-diverged',
  GIT_DIRTY:        'git-dirty',
  VALIDATION:       'validation',
  DEPENDENCY:       'dependency',
  PHASE_STUCK:      'phase-stuck',
  MONITOR_WAIT:     'monitor-wait',
  ORCHESTRATOR_BUG: 'orchestrator-bug',
  BUDGET:           'budget',
  UNKNOWN:          'unknown',
};

// maxAttempts = 0 → classify only, never retry
const META = {
  // A second LLM call cannot repair an exhausted provider/account window.
  // Classification is recoverable=false here because the durable scheduler,
  // not AutoHealer, owns the reset-time resume.
  [ERROR_KINDS.PROVIDER_LIMIT]:    { severity: 'medium', recoverable: false, maxAttempts: 0, windowMinutes: 360 },
  // runClaude already owns one bounded subprocess retry loop. Treating the
  // exhausted result as healable caused a second outer loop (up to five
  // redispatches), multiplying one outage into ~15 provider attempts. The
  // durable job scheduler now owns the delayed retry after runClaude gives up.
  [ERROR_KINDS.NETWORK]:          { severity: 'low',    recoverable: false, maxAttempts: 0, windowMinutes: 30  },
  [ERROR_KINDS.GIT_DIVERGED]:     { severity: 'medium', recoverable: true,  maxAttempts: 3, windowMinutes: 60  },
  [ERROR_KINDS.GIT_DIRTY]:        { severity: 'low',    recoverable: true,  maxAttempts: 3, windowMinutes: 30  },
  [ERROR_KINDS.VALIDATION]:       { severity: 'medium', recoverable: false, maxAttempts: 0, windowMinutes: 60  },
  [ERROR_KINDS.DEPENDENCY]:       { severity: 'medium', recoverable: true,  maxAttempts: 2, windowMinutes: 60  },
  [ERROR_KINDS.PHASE_STUCK]:      { severity: 'medium', recoverable: true,  maxAttempts: 20, windowMinutes: 120 },
  // Dev agent exited while waiting for a Monitor/background-task notification
  // that never arrived (Monitor is unreliable in headless subprocess mode).
  // Treat identically to phase-stuck: reset and retry. maxAttempts kept low
  // because legitimate work was committed before the wait — the phase/fix
  // may be complete; the orchestrator's idempotency gate handles that.
  [ERROR_KINDS.MONITOR_WAIT]:     { severity: 'medium', recoverable: true,  maxAttempts: 2, windowMinutes: 120 },
  [ERROR_KINDS.ORCHESTRATOR_BUG]: { severity: 'high',   recoverable: true,  maxAttempts: 1, windowMinutes: 120 },
  [ERROR_KINDS.BUDGET]:           { severity: 'medium', recoverable: false, maxAttempts: 0, windowMinutes: 360 },
  [ERROR_KINDS.UNKNOWN]:          { severity: 'high',   recoverable: false, maxAttempts: 0, windowMinutes: 60  },
};

// Ordered: first match wins. More-specific patterns go earlier.
const PATTERN_RULES = [
  {
    kind: ERROR_KINDS.PROVIDER_LIMIT,
    tests: [
      /rate.?limit/i, /rate_limit_event/i, /too many requests/i, /\b429\b/i,
      /session.?limit/i, /usage.?limit/i,
      /you.?ve.{0,12}(hit|reached).{0,20}limit/i, /max.?plan.{0,20}limit/i,
      /weekly.{0,24}(usage|rate|token|message)?.{0,12}limit/i,
      /(usage|rate|token|message).{0,24}weekly.{0,12}limit/i,
      /quota.{0,20}exceeded/i, /credit balance/i, /five[_ -]?hour/i,
      /provider circuit (breaker )?open/i,
    ],
  },
  {
    kind: ERROR_KINDS.BUDGET,
    tests: [/budget/i, /billing.*window/i, /5-hour/i, /max.*calls/i, /pause threshold/i],
  },
  {
    // Dev agent ended its subprocess while waiting for a Monitor/background-task
    // notification that never arrived. This is NOT an orchestrator code bug —
    // Monitor is unreliable in headless subprocess mode. Reset and retry; the
    // phase-runner idempotency gate will detect a completed commit and skip re-work.
    kind: ERROR_KINDS.MONITOR_WAIT,
    tests: [
      /i['']ll wait for.*monitor/i, /waiting for.*monitor.*notification/i,
      /stop polling and wait for.*monitor/i, /wait for the monitor event/i,
      /waiting for the monitor notification/i,
      /i['']ll wait for.*background.*completion/i, /waiting for.*background.*notification/i,
      /waiting for background completion/i,
      /rather than spin.*wait/i, /wait for that completion notification/i,
      /i['']ll stop polling/i,
    ],
  },
  {
    kind: ERROR_KINDS.PHASE_STUCK,
    tests: [
      /stalled.*no output/i, /timed out after \d+m/i, /idle.*timeout/i,
      /subprocess.*timeout/i, /task.*timeout/i,
      // Claude hit the max-turns ceiling — not an orchestrator bug, reset and retry
      /error_max_turns/i, /reached maximum number of turns/i, /max.*turns.*exceeded/i,
      // Subprocess exit failures — enrichError wraps these with a stack pointing into
      // src/claude-runner.js, which would otherwise trigger the ORCHESTRATOR_BUG
      // heuristic and waste a self-heal Claude call trying to "fix" the runner.
      /claude exited \d+/i, /no {"type":"result"} message/i, /stream produced no output/i,
      /tool call hung for \d+m/i, /turn stalled — no completion/i,
    ],
  },
  {
    kind: ERROR_KINDS.NETWORK,
    tests: [
      /ECONNRESET/i, /ETIMEDOUT/i, /ENOTFOUND/i, /ECONNREFUSED/i,
      /socket hang up/i, /network error/i, /fetch failed/i,
      /\b502\b/i, /\b503\b/i, /\b504\b/i, /\b529\b/i,
      /connection.*closed/i, /socket.*closed/i,
    ],
  },
  {
    kind: ERROR_KINDS.GIT_DIVERGED,
    tests: [/diverged/i, /cannot fast.forward/i, /rejected.*non-fast-forward/i],
  },
  {
    kind: ERROR_KINDS.GIT_DIRTY,
    tests: [
      // "uncommitted change" (no trailing s) also matches "uncommitted change(s)"
      // as emitted by git.js pull guards — the plural-only form missed it and the
      // error fell through to the ORCHESTRATOR_BUG heuristic (healing_log Jul 19).
      /dirty/i, /uncommitted change/i, /cannot pull/i,
      /your working tree has/i, /untracked files prevent/i,
    ],
  },
  {
    kind: ERROR_KINDS.VALIDATION,
    tests: [
      /validation failed/i, /schema.*error/i, /required property/i,
      /invalid\s+\w*\s*config/i, /ajv/i, /must be.*type/i,
      // v0.15.0: gate-mode acceptance-check terminal failure (verify-loop.js /
      // phase-runner.js runAcceptanceGateLoop) — same shape as a validator-gate
      // failure, must route the same way (never ORCHESTRATOR_BUG).
      /failed acceptance verification/i,
    ],
  },
  {
    kind: ERROR_KINDS.DEPENDENCY,
    tests: [
      /cannot find module/i, /module not found/i,
      /missing peer/i, /ENOENT.*node_modules/i,
    ],
  },
];

/**
 * Classify an error into a recoverable category.
 *
 * @param {Error|string} err
 * @returns {{ kind, severity, recoverable, maxAttempts, windowMinutes }}
 */
export function classifyError(err) {
  const msg   = String(err?.message ?? err ?? '');
  const stack = err?.stack ?? '';
  // Stack frames end in `file.js:429:13` — bare numeric status patterns
  // (\b429\b, \b5xx\b) match those line/column numbers and terminally
  // misclassify a genuine orchestrator bug as a provider/network event
  // (recoverable:false, self-heal suppressed). Strip location suffixes from
  // the stack before matching; the message keeps full fidelity.
  const stackForMatch = String(stack).replace(/:\d+(?::\d+)?(?=\)|\s|$)/g, '');

  for (const { kind, tests } of PATTERN_RULES) {
    if (tests.some((re) => re.test(msg) || re.test(stackForMatch))) {
      return { kind, ...META[kind] };
    }
  }

  // Heuristic: a REAL stack trace (has "at " frame lines) pointing into orchestrator
  // src/ (not node_modules, not projects/workspace) with no spawn/ENOENT markers →
  // likely an orchestrator code bug we can ask Claude to fix.
  //
  // Require actual stack frames ("at ") so that dev-agent text that mentions
  // "/src/" file paths in its SUCCESS summary does not false-trigger this branch
  // and create spurious orchestrator-bug healing entries.
  const hasRealStackFrames = /^\s+at /m.test(stack);
  const pointsIntoSrc = /\/src\/(?!.*node_modules)/.test(stack);
  const isSpawnErr    = /spawn|ENOENT|EPERM|EACCES/i.test(msg);
  const isProjectCode = /\/projects\/.*\/workspace\//i.test(stack);
  if (hasRealStackFrames && pointsIntoSrc && !isSpawnErr && !isProjectCode) {
    return { kind: ERROR_KINDS.ORCHESTRATOR_BUG, ...META[ERROR_KINDS.ORCHESTRATOR_BUG] };
  }

  return { kind: ERROR_KINDS.UNKNOWN, ...META[ERROR_KINDS.UNKNOWN] };
}
