// Shared identifiers for the control-server MCP tools (chat control plane).
// Zero external imports for the same reason as tool-names.js: chat-engine.js
// (which runs inside the CLI and the web-ui process) needs these constants to
// build --mcp-config / --allowedTools without pulling @modelcontextprotocol/sdk
// into its module graph — control-server.mjs is the only file that imports the
// SDK itself.

export const CONTROL_SERVER_NAME = 'aorch-control';

export const CONTROL_TOOL_NAMES = [
  // read
  'list_projects',
  'project_overview',
  'read_artifact',
  'window_status',
  'list_jobs',
  'list_inbox',
  'spend_report',
  'predict',
  'read_upload',
  'self_dev_log',
  'get_run_timeline',
  'get_live_progress',
  'get_quality_report',
  'explain_routing',
  'forecast_run',
  // capture (instant writes)
  'add_bug',
  'add_requirement',
  'write_raw_thoughts',
  'save_brief',
  'queue_brief',
  'remove_queued_brief',
  // actions (spawn detached orchestrator work)
  'create_project',
  'generate_brief',
  'plan_project',
  'start_run',
  'brief_chain',
  'run_next_phase',
  'resume_run',
  'abort_run',
  'retry_phase',
  'start_bug_round',
  'run_audit',
  'run_pipeline',
  'ship_project',
  'orchestrator_dev',
  // discussions (multi-agent panel)
  'start_discussion',
  'list_discussions',
  'discussion_result',
  // suggestions
  'scan_suggestions',
  'get_suggestions',
  'accept_suggestions',
  // quality & lifecycle
  'run_roadmap',
  'run_retro',
  'run_review',
  'run_validators',
  'guide_handoff',
  'sync_project',
  'refresh_context',
  'set_checkpoint_policy',
  'mark_qa',
  'promote_audit',
  'promote_bugs',
  'promote_requirements',
  'orchestrator_pull',
  'self_status',
  'self_restart_ui',
  'workspace_shell',
  // capability (phase C — audit-flagged gaps)
  'repair',
  'inspect_phase',
  'refine_inbox',
  'qa_handoff',
  'roadmap_accept',
  // autopilot (thread-scoped)
  'set_autopilot',
];

/** `mcp__aorch-control__list_projects`, etc. — the --allowedTools naming convention for MCP tools. */
export function qualifiedControlToolNames() {
  return CONTROL_TOOL_NAMES.map((name) => `mcp__${CONTROL_SERVER_NAME}__${name}`);
}
