// Shared identifiers for the state-server MCP tools (Phase 11). Deliberately
// has ZERO external imports: claude-runner.js (the hot dev/fix spawn path,
// imported by nearly every module in this repo) needs these two constants to
// build --mcp-config / --allowedTools, but must NOT pull
// @modelcontextprotocol/sdk's module graph into that path when cfg.mcp.enabled
// is false (the default, dark-launch state) — state-server.mjs is the only
// file that imports the SDK itself.

export const MCP_SERVER_NAME = 'aorch-state';

export const MCP_TOOL_NAMES = [
  'get_decisions', 'get_phase_report', 'get_bug_history', 'get_lessons', 'log_lesson',
  // Phase 38 (CE-6): promoted the server out of dark-launch and added these two
  // — get_phase_ledger reads the P1 phase-ledger.jsonl, get_repo_map serves the
  // on-disk deterministic repo map. Both fail-open on a missing file.
  'get_phase_ledger', 'get_repo_map',
  // Phase 48: non-blocking operator question channel. Listed here
  // UNCONDITIONALLY (this array has zero config awareness by design — see the
  // module comment) so its qualified name always rides along in
  // --allowedTools for every MCP-enabled spawn; config/defaults.json's
  // operator_questions.enabled instead gates whether state-server.mjs's
  // ListTools/CallTool handlers actually serve it, per project.
  'ask_operator',
];

// Schema 19: advertised only when context_compiler is in assist/enforce mode
// AND the invocation owns a successfully compiled exact manifest binding.
// Keeping these separate means shadow/compile-failure paths pay zero MCP
// tool-schema tokens and preserve the pre-compiler allowed-tool args.
export const CONTEXT_MCP_TOOL_NAMES = [
  'get_compiled_context', 'query_code_symbols', 'get_test_impact',
];

/** `mcp__aorch-state__get_decisions`, etc. — the --allowedTools naming convention for MCP tools. */
export function qualifiedMcpToolNames({ includeContext = false } = {}) {
  const names = includeContext ? [...MCP_TOOL_NAMES, ...CONTEXT_MCP_TOOL_NAMES] : MCP_TOOL_NAMES;
  return names.map((name) => `mcp__${MCP_SERVER_NAME}__${name}`);
}
