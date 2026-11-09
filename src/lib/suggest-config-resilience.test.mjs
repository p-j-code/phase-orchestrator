import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const suggestPath = path.join(__dirname, '..', 'commands', 'suggest.js');

const src = await readFile(suggestPath, 'utf8');

// (1) Anchor on the resolveConfig call — the load-bearing observable this test protects.
const resolveConfigIdx = src.indexOf("resolveConfig({ project: projectName, task: 'suggest-scan' })");
assert.ok(resolveConfigIdx !== -1, 'resolveConfig({ project: projectName, task: \'suggest-scan\' }) not found in suggest.js');

// (2) A `try {` block must precede the resolveConfig call in the same section.
const innerTryIdx = src.slice(0, resolveConfigIdx).lastIndexOf('try {');
assert.ok(innerTryIdx !== -1, 'try { block not found before resolveConfig call in suggest.js');

// (3) The rules-fallback `generateSuggestions(snapshot)` call must appear after the
//     resolveConfig call (i.e. in the catch block). The actual source uses
//     `const raw = generateSuggestions(snapshot)` — anchor on the shared suffix.
const generateSuggestionsIdx = src.slice(resolveConfigIdx).indexOf('generateSuggestions(snapshot)');
assert.ok(generateSuggestionsIdx !== -1, 'generateSuggestions(snapshot) fallback not found after resolveConfig call in suggest.js');

// (4) The aiSpinner ora(...) declaration must appear before the enclosing try { so it
//     is in scope inside the catch block.
const aiSpinnerIdx = src.slice(0, innerTryIdx).lastIndexOf("ora('Asking Claude to analyse your project");
assert.ok(aiSpinnerIdx !== -1, 'aiSpinner ora(...) declaration not found before try { in suggest.js');

console.log('suggest-config-resilience: all assertions passed');
