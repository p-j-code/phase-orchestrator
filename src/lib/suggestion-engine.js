// src/lib/suggestion-engine.js
//
// Deterministic, rules-based suggestion engine.
// No I/O, no external calls, no Date-dependent ordering.

/** @typedef {import('./project-scanner.js').ScanSnapshot} ScanSnapshot */

/**
 * @typedef {Object} Suggestion
 * @property {string}   id            stable kebab-case identifier
 * @property {string}   type          'new-feature'|'enhancement'|'ui-improvement'|'perf'|'security'|'dx'
 * @property {string}   category      'logic'|'frontend'|'infra'|'security'|'dx'|'both'
 * @property {string}   title         ≤60 chars
 * @property {string}   description   1-2 sentences
 * @property {string}   effort        'small'|'medium'|'large'
 * @property {string}   impact        'low'|'medium'|'high'
 * @property {number}   suggestedSlot 1|2|3
 * @property {string[]} appliesTo     project types this applies to
 */

const RULES = [
  // ─── CLI rules ──────────────────────────────────────────────────────────────
  {
    id: 'cli-config-file',
    appliesTo: ['cli'],
    requires: () => true,
    template: {
      type: 'new-feature', category: 'logic',
      title: 'Support .rc / JSON config file',
      description: 'Let users persist preferences in a named config file (e.g. .ashmerc.json) so flags do not need repeating on every invocation.',
      effort: 'medium', impact: 'high', suggestedSlot: 1,
    },
    dedupeKeywords: ['config file', '.rc', 'rc file'],
  },
  {
    id: 'cli-plugin-system',
    appliesTo: ['cli'],
    requires: () => true,
    template: {
      type: 'new-feature', category: 'logic',
      title: 'Plugin / extension loading from node_modules',
      description: 'Discover and load plugins prefixed by the CLI name from node_modules, enabling third-party extensions without forking the core.',
      effort: 'large', impact: 'medium', suggestedSlot: 2,
    },
    dedupeKeywords: ['plugin', 'extension system'],
  },
  {
    id: 'cli-shell-completion',
    appliesTo: ['cli'],
    requires: () => true,
    template: {
      type: 'dx', category: 'dx',
      title: 'Bash/zsh tab completion',
      description: 'Generate and install shell completion scripts so operators can tab-complete commands and flags.',
      effort: 'small', impact: 'medium', suggestedSlot: 2,
    },
    dedupeKeywords: ['tab completion', 'shell completion', 'autocomplete'],
  },
  {
    id: 'cli-progress-output',
    appliesTo: ['cli'],
    requires: () => true,
    template: {
      type: 'enhancement', category: 'dx',
      title: 'Structured progress and spinner output via ora',
      description: 'Replace raw console.log with ora spinners and chalk-coloured status lines so long operations feel responsive and output is parseable.',
      effort: 'small', impact: 'high', suggestedSlot: 1,
    },
    dedupeKeywords: ['spinner', 'progress output', 'ora'],
  },
  {
    id: 'cli-dry-run',
    appliesTo: ['cli'],
    requires: () => true,
    template: {
      type: 'dx', category: 'dx',
      title: 'Add --dry-run flag for destructive commands',
      description: 'Allow operators to preview the effect of destructive operations (file writes, API calls, DB mutations) without committing them.',
      effort: 'small', impact: 'high', suggestedSlot: 1,
    },
    dedupeKeywords: ['dry run', 'dry-run'],
  },

  // ─── Frontend rules ──────────────────────────────────────────────────────────
  {
    id: 'fe-mobile-responsive',
    appliesTo: ['frontend', 'fullstack'],
    requires: () => true,
    template: {
      type: 'ui-improvement', category: 'frontend',
      title: 'Mobile-responsive layout with bottom nav',
      description: 'Adapt layouts for small screens and replace the sidebar with a bottom navigation bar on mobile breakpoints.',
      effort: 'medium', impact: 'high', suggestedSlot: 1,
    },
    dedupeKeywords: ['mobile responsive', 'bottom nav', 'responsive layout'],
  },
  {
    id: 'fe-loading-skeletons',
    appliesTo: ['frontend', 'fullstack'],
    requires: () => true,
    template: {
      type: 'ui-improvement', category: 'frontend',
      title: 'Skeleton screens instead of spinners',
      description: 'Replace loading spinners with content-shaped skeleton placeholders to reduce perceived load time and prevent layout shift.',
      effort: 'small', impact: 'high', suggestedSlot: 1,
    },
    dedupeKeywords: ['skeleton', 'loading skeleton'],
  },
  {
    id: 'fe-dark-mode',
    appliesTo: ['frontend', 'fullstack'],
    requires: () => true,
    template: {
      type: 'ui-improvement', category: 'frontend',
      title: 'Dark / light mode toggle persisted to localStorage',
      description: 'Add a theme toggle that persists the user preference in localStorage and respects prefers-color-scheme on first visit.',
      effort: 'medium', impact: 'medium', suggestedSlot: 2,
    },
    dedupeKeywords: ['dark mode', 'light mode', 'theme toggle'],
  },
  {
    id: 'fe-empty-states',
    appliesTo: ['frontend', 'fullstack'],
    requires: () => true,
    template: {
      type: 'ui-improvement', category: 'frontend',
      title: 'Illustrated empty states on all list views',
      description: 'Show a helpful empty-state illustration and call-to-action instead of a blank area when list or table views have no data.',
      effort: 'small', impact: 'medium', suggestedSlot: 1,
    },
    dedupeKeywords: ['empty state', 'empty screen'],
  },
  {
    id: 'fe-form-validation',
    appliesTo: ['frontend', 'fullstack'],
    requires: () => true,
    template: {
      type: 'enhancement', category: 'frontend',
      title: 'Real-time field-level form validation',
      description: 'Add per-field validation with inline error messages that appear on blur and clear on correction, without waiting for submit.',
      effort: 'small', impact: 'high', suggestedSlot: 1,
    },
    dedupeKeywords: ['form validation', 'field validation'],
  },
  {
    id: 'fe-optimistic-updates',
    appliesTo: ['frontend', 'fullstack'],
    requires: () => true,
    template: {
      type: 'enhancement', category: 'frontend',
      title: 'Optimistic UI on mutations',
      description: 'Apply mutations to local UI state immediately and roll back on API error, so the interface feels instant under normal conditions.',
      effort: 'medium', impact: 'high', suggestedSlot: 2,
    },
    dedupeKeywords: ['optimistic', 'optimistic update'],
  },
  {
    id: 'fe-pagination',
    appliesTo: ['frontend', 'fullstack'],
    requires: () => true,
    template: {
      type: 'enhancement', category: 'frontend',
      title: 'Paginate all long lists',
      description: 'Add page controls or infinite scroll to every list/table view that can grow beyond one screen of data.',
      effort: 'small', impact: 'high', suggestedSlot: 1,
    },
    dedupeKeywords: ['pagination', 'paginate'],
  },
  {
    id: 'fe-search-debounce',
    appliesTo: ['frontend', 'fullstack'],
    requires: () => true,
    template: {
      type: 'enhancement', category: 'frontend',
      title: 'Debounce search and filter inputs',
      description: 'Delay search/filter API calls until the user pauses typing (300 ms debounce) to avoid hammering the API on every keystroke.',
      effort: 'small', impact: 'medium', suggestedSlot: 1,
    },
    dedupeKeywords: ['debounce', 'search debounce'],
  },

  // ─── API rules ───────────────────────────────────────────────────────────────
  {
    id: 'api-input-validation',
    appliesTo: ['api', 'fullstack'],
    requires: () => true,
    template: {
      type: 'security', category: 'security',
      title: 'Schema validation on all request bodies',
      description: 'Validate every request body against a schema (zod or joi) at the route layer and return structured 400 errors on failure.',
      effort: 'small', impact: 'high', suggestedSlot: 1,
    },
    dedupeKeywords: ['input validation', 'request validation', 'schema validation'],
  },
  {
    id: 'api-rate-limiting',
    appliesTo: ['api', 'fullstack'],
    requires: () => true,
    template: {
      type: 'security', category: 'security',
      title: 'Per-IP / per-token rate limiting',
      description: 'Apply rate limits to public endpoints using an in-process token bucket or a Redis-backed counter to block abusive clients.',
      effort: 'small', impact: 'high', suggestedSlot: 1,
    },
    dedupeKeywords: ['rate limit', 'rate-limit', 'rate limiting'],
  },
  {
    id: 'api-structured-logging',
    appliesTo: ['api', 'fullstack'],
    requires: () => true,
    template: {
      type: 'dx', category: 'dx',
      title: 'Structured JSON logs with request IDs',
      description: 'Replace ad-hoc console.log with structured JSON logging that includes a per-request correlation ID for easier log querying.',
      effort: 'small', impact: 'medium', suggestedSlot: 1,
    },
    dedupeKeywords: ['structured log', 'json log', 'request id'],
  },
  {
    id: 'api-health-endpoint',
    appliesTo: ['api', 'fullstack'],
    requires: () => true,
    template: {
      type: 'dx', category: 'dx',
      title: '/health and /ready endpoints',
      description: 'Add lightweight /health (is the process alive?) and /ready (are all dependencies up?) endpoints for load balancers and monitoring.',
      effort: 'small', impact: 'medium', suggestedSlot: 1,
    },
    dedupeKeywords: ['health endpoint', '/health', 'readiness'],
  },
  {
    id: 'api-pagination-cursor',
    appliesTo: ['api', 'fullstack'],
    requires: () => true,
    template: {
      type: 'enhancement', category: 'logic',
      title: 'Cursor-based pagination on list endpoints',
      description: 'Replace offset pagination with cursor-based pagination (keyset) on all list endpoints so large datasets can be navigated stably.',
      effort: 'medium', impact: 'high', suggestedSlot: 2,
    },
    dedupeKeywords: ['cursor pagination', 'keyset pagination'],
  },
  {
    id: 'api-request-tracing',
    appliesTo: ['api', 'fullstack'],
    requires: () => true,
    template: {
      type: 'dx', category: 'dx',
      title: 'Correlation IDs propagated through async calls',
      description: 'Generate a unique request ID per inbound request and propagate it through all downstream DB, queue, and HTTP calls for end-to-end tracing.',
      effort: 'medium', impact: 'medium', suggestedSlot: 2,
    },
    dedupeKeywords: ['correlation id', 'tracing', 'request tracing'],
  },

  // ─── All-type rules ──────────────────────────────────────────────────────────
  {
    id: 'auth-oauth',
    appliesTo: ['cli', 'frontend', 'api', 'fullstack', 'unknown'],
    requires: (s) => !['passport', 'next-auth', 'lucia', '@auth/core'].some(
      lib => s.dependencies.some(d => d.includes(lib)),
    ),
    template: {
      type: 'new-feature', category: 'logic',
      title: 'OAuth 2.0 sign-in integration',
      description: 'Add OAuth 2.0 sign-in (Google, GitHub) so users can authenticate without a username/password, reducing onboarding friction.',
      effort: 'large', impact: 'high', suggestedSlot: 2,
    },
    dedupeKeywords: ['oauth', 'sign-in', 'authentication', 'auth flow'],
  },
  {
    id: 'export-csv-pdf',
    appliesTo: ['cli', 'frontend', 'api', 'fullstack', 'unknown'],
    requires: (s) => s.completedPhases > 3,
    template: {
      type: 'new-feature', category: 'logic',
      title: 'Export data to CSV and PDF',
      description: 'Let users export any list or report view as a CSV file or a formatted PDF, downloadable directly from the UI or API.',
      effort: 'medium', impact: 'medium', suggestedSlot: 2,
    },
    dedupeKeywords: ['export csv', 'export pdf', 'download csv'],
  },
  {
    id: 'test-coverage',
    appliesTo: ['cli', 'frontend', 'api', 'fullstack', 'unknown'],
    requires: (s) => !['vitest', 'jest', 'mocha', 'jasmine', 'ava'].some(
      lib => s.dependencies.some(d => d.includes(lib)),
    ),
    template: {
      type: 'dx', category: 'dx',
      title: 'Add / expand unit and integration tests',
      description: 'Set up a test framework (node:test, vitest, or jest) and add unit tests for core logic and integration tests for key flows.',
      effort: 'medium', impact: 'high', suggestedSlot: 1,
    },
    dedupeKeywords: ['unit test', 'integration test', 'test coverage', 'test suite'],
  },
  {
    id: 'ci-pipeline',
    appliesTo: ['cli', 'frontend', 'api', 'fullstack', 'unknown'],
    requires: (s) => !s.rootDirs?.includes('.github'),
    template: {
      type: 'dx', category: 'infra',
      title: 'GitHub Actions CI pipeline',
      description: 'Add a .github/workflows/ci.yml that runs tests, linting, and a build check on every push and pull request.',
      effort: 'small', impact: 'medium', suggestedSlot: 2,
    },
    dedupeKeywords: ['github actions', 'ci pipeline', 'ci/cd', 'continuous integration'],
  },
  {
    id: 'error-monitoring',
    appliesTo: ['cli', 'frontend', 'api', 'fullstack', 'unknown'],
    requires: () => true,
    template: {
      type: 'dx', category: 'infra',
      title: 'Client error capture and reporting',
      description: 'Integrate a lightweight error reporting solution (Sentry, Axiom, or a custom webhook) to capture and alert on unhandled exceptions in production.',
      effort: 'small', impact: 'medium', suggestedSlot: 2,
    },
    dedupeKeywords: ['error monitoring', 'sentry', 'error reporting'],
  },
  {
    id: 'sse-realtime',
    appliesTo: ['api', 'fullstack'],
    requires: () => true,
    template: {
      type: 'new-feature', category: 'logic',
      title: 'Real-time updates via Server-Sent Events',
      description: 'Push live data updates to connected clients over a persistent SSE stream, avoiding polling and eliminating the need for WebSockets.',
      effort: 'medium', impact: 'high', suggestedSlot: 2,
    },
    dedupeKeywords: ['server-sent events', 'sse', 'real-time', 'realtime'],
  },
  {
    id: 'telegram-bot-integration',
    appliesTo: ['cli', 'frontend', 'api', 'fullstack', 'unknown'],
    requires: (s) => !['grammy', 'telegraf', 'node-telegram-bot-api'].some(
      lib => s.dependencies.some(d => d.includes(lib)),
    ),
    template: {
      type: 'new-feature', category: 'logic',
      title: 'Telegram bot for operator control',
      description: 'Add a Telegram bot interface so the operator can trigger commands, check status, and receive alerts from a phone without opening a terminal.',
      effort: 'large', impact: 'high', suggestedSlot: 3,
    },
    dedupeKeywords: ['telegram', 'telegram bot', 'bot integration'],
  },
];

/**
 * Filter a suggestion list by selected categories.
 * Pure function — no I/O, no side effects.
 * @param {Suggestion[]} suggestions
 * @param {string[]} categories
 * @returns {Suggestion[]}
 */
export function filterSuggestions(suggestions, categories) {
  if (!categories.length) return suggestions;
  return suggestions
    .filter(s => s.category === 'both' || categories.includes(s.category));
}

/**
 * Assign selected suggestions to pipeline passes using suggestedSlot clamped to passes.
 * Pure function — no I/O, deterministic.
 * @param {Suggestion[]} selected
 * @param {number} passes  1 | 2 | 3
 * @returns {{ [pass: string]: string[] }}  e.g. { "1": ["id-a"], "2": ["id-b"] }
 */
export function assignToPasses(selected, passes) {
  const plan = {};
  for (let p = 1; p <= passes; p++) plan[String(p)] = [];
  for (const s of selected) {
    const slot = passes === 1 ? 1 : Math.min(s.suggestedSlot, passes);
    plan[String(slot)].push(s.id);
  }
  return plan;
}

/**
 * Resolve the pass slot to actually inject into the guide prompt.
 *
 * If the requested slot has items in the plan, return it unchanged.
 * If the requested slot is empty (but in range), find and return the
 * lowest-numbered pass that has items so the guide always receives a
 * non-empty suggestions block.
 * If no pass has items at all, return requestedSlot unchanged — the
 * existing empty-pass warning in loadSuggestionsBlock handles that case.
 *
 * @param {{ [pass: string]: string[] }} pipelinePlan  — parsed pipeline_plan_json
 * @param {number} requestedSlot   — slot from --slot flag (default: 1)
 * @param {number} passes          — total passes in the accepted plan
 * @returns {number}               — slot to actually inject
 */
export function resolveInjectionSlot(pipelinePlan, requestedSlot, passes) {
  const items = (pipelinePlan[String(requestedSlot)] || []);
  if (items.length > 0) return requestedSlot;

  for (let p = 1; p <= passes; p++) {
    if ((pipelinePlan[String(p)] || []).length > 0) return p;
  }
  return requestedSlot;
}

/**
 * Find the next non-empty pass after `afterPass`.
 * Returns null if no later pass has items (already at or past the last non-empty pass).
 * @param {{ [pass: string]: string[] }} pipelinePlan
 * @param {number} afterPass   — the pass that just ran
 * @param {number} totalPasses — pipeline_passes from the accepted plan
 * @returns {number|null}
 */
export function nextNonEmptyPass(pipelinePlan, afterPass, totalPasses) {
  for (let p = afterPass + 1; p <= totalPasses; p++) {
    if ((pipelinePlan[String(p)] || []).length > 0) return p;
  }
  return null;
}

/**
 * Generate a filtered, deduplicated suggestion list for a project snapshot.
 * @param {ScanSnapshot} snapshot
 * @returns {Suggestion[]}
 */
export function generateSuggestions(snapshot) {
  const { projectType, completedPhases, phaseTitles } = snapshot;
  return RULES
    .filter(rule => rule.appliesTo.includes(projectType))
    .filter(rule => rule.requires(snapshot))
    .filter(rule => !_isDedupSuppressed(rule, completedPhases, phaseTitles))
    .map(rule => ({
      id:           rule.id,
      type:         rule.template.type,
      category:     rule.template.category,
      title:        rule.template.title,
      description:  rule.template.description,
      effort:       rule.template.effort,
      impact:       rule.template.impact,
      suggestedSlot:rule.template.suggestedSlot,
      appliesTo:    rule.appliesTo,
    }));
}

/**
 * Conservative keyword de-dup. Suppresses a rule only if ALL conditions hold:
 *   - completedPhases > 0
 *   - rule.dedupeKeywords is non-empty
 *   - at least one keyword is a case-insensitive substring of at least one phase title
 * Conservative: short keywords (< 4 chars) are skipped to avoid false positives.
 */
function _isDedupSuppressed(rule, completedPhases, phaseTitles) {
  if (completedPhases === 0) return false;
  if (!rule.dedupeKeywords?.length) return false;
  const titlesLower = phaseTitles.map(t => t.toLowerCase());
  return rule.dedupeKeywords
    .filter(kw => kw.length >= 4)
    .some(kw => titlesLower.some(title => title.includes(kw.toLowerCase())));
}
