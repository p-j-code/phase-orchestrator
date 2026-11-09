// `ashmero chat [project]` — interactive control-plane chat in the terminal.
// A thin REPL over src/chat/chat-engine.js: same engine, same threads, same
// MCP control tools as the web UI chat. Local slash-commands handle thread
// management without burning a Claude call.

import { createInterface } from 'node:readline/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import {
  sendChatMessage, createChatThread, getChatThread, listChatThreads, listChatMessages,
} from '../chat/chat-engine.js';
import { storeChatUpload } from '../chat/control-actions.js';
import { listProjects, getProject } from '../state.js';

const HELP = `
${chalk.bold('Local commands')} (no Claude call):
  /project <name>   focus a project for this thread
  /attach <path>    attach a file (text or image) to your next message
  /threads          list recent threads
  /open <id>        switch to a thread
  /new              start a fresh thread
  /history          re-print this thread's messages
  /help             this help
  /exit             quit
Anything else goes to the control agent — e.g. ${chalk.dim('"status?", "add a bug to shop: …", "queue briefs for X and Y then run all"')}.`;

function printMessage(role, content) {
  if (role === 'user') {
    console.log(`\n${chalk.bold.cyan('you')}  ${content}`);
  } else if (role === 'system') {
    console.log(`\n${chalk.yellow(content)}`);
  } else {
    console.log(`\n${chalk.bold.green('aorch')}  ${content}`);
  }
}

export async function chatRepl({ project = null, fresh = false } = {}) {
  if (project && !getProject(project)) {
    console.error(chalk.red(`Project not found: ${project}`));
    process.exitCode = 1;
    return;
  }

  // Pick up the most recent thread unless --new (fresh context) was asked.
  let thread = null;
  if (!fresh) {
    const threads = listChatThreads(1);
    if (threads.length) thread = threads[0];
  }
  let threadId = thread?.id ?? null;
  let focusProject = project || thread?.project || null;
  let pendingAttachments = []; // [{name, label}] queued by /attach for the next message

  const projects = listProjects();
  console.log(chalk.bold('\n◆ Ashmero Control — chat'));
  console.log(chalk.dim(`${projects.length} project(s): ${projects.map((p) => p.name).join(', ') || '(none)'}`));
  if (threadId) console.log(chalk.dim(`resuming thread #${threadId}${thread.title ? ` — ${thread.title}` : ''} (use /new for a fresh one)`));
  if (focusProject) console.log(chalk.dim(`focus project: ${focusProject}`));
  console.log(chalk.dim('type /help for local commands, /exit to quit'));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => { rl.close(); });

  try {
    for (;;) {
      let line;
      try {
        line = await rl.question(chalk.bold.cyan('\nyou> '));
      } catch {
        break; // readline closed (Ctrl-C / Ctrl-D)
      }
      const input = line.trim();
      if (!input) continue;

      // ── local commands ──
      if (input === '/exit' || input === '/quit') break;
      if (input === '/help') { console.log(HELP); continue; }
      if (input === '/new') {
        threadId = null;
        console.log(chalk.dim('fresh thread — next message starts it'));
        continue;
      }
      if (input === '/threads') {
        for (const t of listChatThreads(10)) {
          console.log(`  #${t.id}  ${chalk.bold(t.title || '(untitled)')} ${chalk.dim(`— ${t.message_count} msg, ${t.project || 'no focus'}, ${t.last_active_at}`)}`);
        }
        continue;
      }
      if (input.startsWith('/open ')) {
        const id = Number(input.slice(6).trim());
        const t = getChatThread(id);
        if (!t) { console.log(chalk.red(`no thread #${id}`)); continue; }
        threadId = t.id;
        focusProject = t.project || focusProject;
        console.log(chalk.dim(`thread #${t.id} — ${t.title || '(untitled)'}`));
        continue;
      }
      if (input.startsWith('/project ')) {
        const name = input.slice(9).trim();
        if (!getProject(name)) { console.log(chalk.red(`no project named ${name}`)); continue; }
        focusProject = name;
        console.log(chalk.dim(`focus project: ${name}`));
        continue;
      }
      if (input.startsWith('/attach ')) {
        const p = input.slice(8).trim().replace(/^~\//, `${process.env.HOME}/`);
        try {
          const buf = await fs.readFile(p);
          const stored = await storeChatUpload(path.basename(p), buf);
          pendingAttachments.push({ name: stored.name, label: path.basename(p) });
          console.log(chalk.dim(`attached ${path.basename(p)} (${stored.size} bytes) — sends with your next message`));
        } catch (err) {
          console.log(chalk.red(`attach failed: ${err.message}`));
        }
        continue;
      }
      if (input === '/history') {
        if (!threadId) { console.log(chalk.dim('no thread yet')); continue; }
        for (const m of listChatMessages(threadId, 50)) printMessage(m.role, m.content);
        continue;
      }
      if (input.startsWith('/')) {
        console.log(chalk.red(`unknown command ${input.split(' ')[0]} — /help lists them`));
        continue;
      }

      // ── send to the control agent ──
      try {
        if (pendingAttachments.length) {
          console.log(chalk.dim(`sending with ${pendingAttachments.length} attachment(s): ${pendingAttachments.map((a) => a.label).join(', ')}`));
        }
        const res = await sendChatMessage({
          threadId, message: input, project: focusProject,
          attachments: pendingAttachments.map((a) => a.name),
        });
        pendingAttachments = [];
        threadId = res.threadId;
        printMessage(res.error ? 'system' : 'assistant', res.reply);
        if (res.cost_usd != null) console.log(chalk.dim(`   $${res.cost_usd.toFixed(4)} this turn`));
      } catch (err) {
        console.log(chalk.red(`✗ ${err.message}`));
      }
    }
  } finally {
    rl.close();
  }
  console.log(chalk.dim('\nbye'));
}
