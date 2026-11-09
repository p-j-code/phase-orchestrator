// Shared XML-escape helper. Keeps the import graph acyclic:
// brief-manager.js and phase-runner.js both import from here; they can't
// import from each other (phase-runner imports from brief-manager).

/**
 * Sanitise workspace-derived content before it is placed inside an XML wrapper
 * tag in a guide/dev system prompt.
 *
 * ORDER: cap first (so HTML-entity inflation cannot corrupt the cap), then
 * escape & before < and > (to prevent double-encoding already-escaped entities).
 *
 * @param {string|null|undefined} raw
 * @param {number} [maxChars] — truncate to this many chars BEFORE escaping
 * @returns {string}
 */
export function sanitiseContent(raw, maxChars) {
  if (raw == null || raw === '') return '';
  const s = typeof maxChars === 'number' ? String(raw).slice(0, maxChars) : String(raw);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
