// Slug — convert a phase/fix title to a filesystem-safe folder name.
//
// "Schema foundation + TDS section master + quarter helpers"
//   → "schema-foundation-tds-section-master-quarter"
//
// Length-capped to ~40 chars to keep paths readable.

export function slugify(title, maxLen = 40) {
  if (!title) return 'untitled';
  let s = String(title).toLowerCase();
  // [^a-z0-9]+ → '-' is also the path-traversal backstop: '..', '/', '\', and
  // any non-ASCII char all fall outside a-z0-9 (post-lowercase), so the output
  // can only ever be [a-z0-9-]. guide-paths.js's assertInsideDir relies on this.
  s = s.replace(/[^a-z0-9]+/g, '-');
  // Strip leading/trailing dashes
  s = s.replace(/^-+|-+$/g, '');
  if (s.length === 0) return 'untitled';
  if (s.length <= maxLen) return s;
  // Truncate at word boundary if possible
  const truncated = s.slice(0, maxLen);
  const lastDash = truncated.lastIndexOf('-');
  if (lastDash > maxLen / 2) return truncated.slice(0, lastDash);
  return truncated;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}
