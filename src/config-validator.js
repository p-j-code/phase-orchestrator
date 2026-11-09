// Config Validator — uses Ajv to validate configs against JSON Schemas.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(__dirname, '..', 'config', 'schemas');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const schemaCache = new Map();

function loadSchema(name) {
  if (schemaCache.has(name)) return schemaCache.get(name);
  const schemaPath = path.join(SCHEMAS_DIR, `${name}.schema.json`);
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Schema not found: ${name} (expected at ${schemaPath})`);
  }
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
  const validateFn = ajv.compile(schema);
  schemaCache.set(name, validateFn);
  return validateFn;
}

// Phase 45 — a filesystem/tool deny rule must be a Claude Code permission
// pattern: a Tool name followed by a parenthesized matcher, e.g.
// `Read(../../../config/**)`, `Bash(curl:*)`. Kept as a plain regex (not an Ajv
// pattern) so validation can name the exact CONFIG LAYER that produced the bad
// value — repo convention (error messages name the offending layer) that Ajv's
// instancePath cannot express across the cascade.
const DENY_RULE_SHAPE = /^[A-Za-z]+\(.+\)$/;

/**
 * Validate every entry of a `security.deny_rules` list against the Tool(pattern)
 * shape. A null/undefined list (layer doesn't set the key) is a no-op. Throws on
 * the first malformed entry, naming `configLayer` so a bad override is traced to
 * the file that produced it.
 *
 * @param {unknown} rules - the layer's security.deny_rules value
 * @param {string} configLayer - human label of the layer being validated
 */
export function validateDenyRules(rules, configLayer) {
  if (rules == null) return;
  if (!Array.isArray(rules)) {
    throw new Error(`Invalid deny rules in ${configLayer}: security.deny_rules must be an array of Tool(pattern) strings`);
  }
  for (const rule of rules) {
    if (typeof rule !== 'string' || !DENY_RULE_SHAPE.test(rule)) {
      throw new Error(
        `Invalid deny rule in ${configLayer}: ${JSON.stringify(rule)} — `
        + `must match the Tool(pattern) shape (e.g. Read(../../../config/**), Bash(curl:*))`,
      );
    }
  }
}

/**
 * Validate every entry of a `tools.task_profiles` map: values must be arrays
 * of strings. Keys (task names) are deliberately UNRESTRICTED — forward-compat
 * with future task ids the validator has no fixed list of. A null/undefined
 * map (layer doesn't set the key) is a no-op. Throws on the first malformed
 * entry, naming `configLayer` — same convention as validateDenyRules.
 *
 * @param {unknown} profiles - the layer's tools.task_profiles value
 * @param {string} configLayer - human label of the layer being validated
 */
export function validateTaskProfiles(profiles, configLayer) {
  if (profiles == null) return;
  if (typeof profiles !== 'object' || Array.isArray(profiles)) {
    throw new Error(`Invalid task_profiles in ${configLayer}: tools.task_profiles must be an object mapping task name -> array of tool name strings`);
  }
  for (const [task, tools] of Object.entries(profiles)) {
    if (!Array.isArray(tools) || !tools.every((t) => typeof t === 'string')) {
      throw new Error(`Invalid task_profiles entry in ${configLayer}: tools.task_profiles[${JSON.stringify(task)}] must be an array of tool name strings, got ${JSON.stringify(tools)}`);
    }
  }
}

/**
 * Validate config object against the named schema. Throws on failure with
 * helpful error message that includes the offending path.
 *
 * @param {Object} cfg - config to validate
 * @param {string} schemaName - one of: defaults, user, project, plan
 */
export function validate(cfg, schemaName) {
  const validateFn = loadSchema(schemaName);
  const valid = validateFn(cfg);
  if (!valid) {
    const errors = validateFn.errors
      .map((e) => `  • ${e.instancePath || '(root)'}: ${e.message}`)
      .join('\n');
    throw new Error(`Invalid ${schemaName} config:\n${errors}`);
  }
}
