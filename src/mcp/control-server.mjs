// MCP control server — a stdio MCP server exposing orchestrator-wide control
// tools to the chat agent (src/chat/chat-engine.js). Unlike state-server.mjs
// (jailed to ONE project's .guide/), this server is global: list/inspect every
// project, capture bugs/requirements/briefs, and kick off runs. All logic
// lives in src/chat/control-actions.js — this file is only the MCP wiring,
// the same shape as state-server.mjs.
//
// Spawned by the `claude` CLI per --mcp-config (written by chat-engine.js),
// never invoked directly by us. stdout is the MCP transport: control-actions
// only ever writes diagnostics to stderr.

import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CONTROL_SERVER_NAME, CONTROL_TOOL_NAMES, qualifiedControlToolNames } from './control-tool-names.js';
import { TOOL_DETAILS_BY_NAME, TOOL_HANDLERS } from '../chat/control-actions.js';

export { CONTROL_SERVER_NAME, CONTROL_TOOL_NAMES, qualifiedControlToolNames };

// Built from CONTROL_TOOL_NAMES (the shared source of truth) so the tool list
// this server advertises can never drift from what chat-engine.js allowlists.
const TOOL_DEFS = CONTROL_TOOL_NAMES.map((name) => ({ name, ...TOOL_DETAILS_BY_NAME[name] }));

export function buildServer() {
  const server = new Server({ name: CONTROL_SERVER_NAME, version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = TOOL_HANDLERS[name];
    if (!handler) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    try {
      const result = await handler(args || {});
      // _mcpContent escape hatch: a handler that needs non-text content blocks
      // (read_upload returning an actual image) provides them verbatim.
      if (result && Array.isArray(result._mcpContent)) {
        return { content: result._mcpContent };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
  });

  return server;
}

export async function main() {
  // The chat engine passes the current thread id via --thread so the
  // thread-scoped set_autopilot tool knows which thread it is acting on. Expose
  // it to the handlers through this process's own env (isolated per spawn).
  const ti = process.argv.indexOf('--thread');
  if (ti !== -1 && process.argv[ti + 1]) process.env.AORCH_CHAT_THREAD_ID = process.argv[ti + 1];

  // --autopilot-tick: this server instance is serving an UNATTENDED loop tick
  // (no human in the conversation). control-actions hard-rejects the tools the
  // <autopilot> directive says the agent must not take alone — the directive
  // is prompt-side policy; this flag is the server-side enforcement of it.
  if (process.argv.includes('--autopilot-tick')) process.env.AORCH_AUTOPILOT_TICK = '1';

  // stdout IS the MCP transport. Several inlined tool paths (performBugPromote,
  // cmdPromote, promoteAuditToBugs, writeSuggestionsFile, chalk banners in the
  // libs they call) console.log progress — remap ALL console.log to stderr so
  // no library can ever corrupt the protocol stream. The SDK writes frames via
  // process.stdout directly, not console.log, so it is unaffected.
  console.log = (...args) => console.error(...args);
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run the stdio server when invoked directly — never when imported for
// the name constants or buildServer (unit tests).
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    console.error(`[control-server] fatal: ${err.message}`);
    process.exit(1);
  });
}
