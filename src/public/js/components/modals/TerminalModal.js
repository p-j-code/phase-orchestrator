// TerminalModal — in-browser terminal for running commands in the orchestrator
// root or any project's workspace. On error shows an "Open in Chat" button
// that navigates to the chat view with the error pre-filled.

import { store } from '../../lib/store.js';
import { api } from '../../lib/api.js';
import { navigate } from '../../lib/router.js';
import { closeModal, handleModalKey, openModal } from '../../lib/modal-a11y.js';

export default {
  name: 'TerminalModal',
  data() {
    return {
      cwdArg: '__root__',
      command: '',
      running: false,
      entries: [],     // [{id, command, stdout, stderr, exit_code, cwd_label, ts}]
      history: [],     // command strings
      historyIdx: -1,
      draftCommand: '',
      nextId: 1,
      controller: null,
    };
  },
  computed: {
    projects() { return store.state.projects || []; },
    stopping() { return this.entries.some((entry) => entry.stopping); },
    contextLabel() {
      if (this.cwdArg === '__root__') return 'orchestrator (root)';
      return `${this.cwdArg}/workspace`;
    },
    promptPrefix() {
      if (this.cwdArg === '__root__') return '~/ashmero';
      return `~/projects/${this.cwdArg}/workspace`;
    },
  },
  mounted() {
    document.addEventListener('keydown', this.onGlobalKey);
    this.$nextTick(() => openModal(this.$refs.backdrop, this.$refs.cmdInput));
  },
  beforeUnmount() {
    document.removeEventListener('keydown', this.onGlobalKey);
    this.controller?.abort();
    closeModal(this.$refs.backdrop);
  },
  methods: {
    close() {
      if (this.running) {
        store.toast('Stop the running command before closing Terminal', 'warn');
        return;
      }
      store.state.showTerminal = false;
    },

    onGlobalKey(e) {
      handleModalKey(this.$refs.backdrop, e, { onEscape: this.close, escapeDisabled: this.running });
    },

    onKeydown(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.run();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.historyUp();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.historyDown();
      } else if (e.key === 'l' && e.ctrlKey) {
        e.preventDefault();
        this.clear();
      }
    },

    historyUp() {
      if (!this.history.length) return;
      if (this.historyIdx === -1) this.draftCommand = this.command;
      const next = this.historyIdx === -1
        ? this.history.length - 1
        : Math.max(0, this.historyIdx - 1);
      this.historyIdx = next;
      this.command = this.history[next];
    },

    historyDown() {
      if (this.historyIdx === -1) return;
      if (this.historyIdx >= this.history.length - 1) {
        this.historyIdx = -1;
        this.command = this.draftCommand;
      } else {
        this.historyIdx += 1;
        this.command = this.history[this.historyIdx];
      }
    },

    clear() { this.entries = []; },

    async run() {
      const cmd = this.command.trim();
      if (!cmd || this.running) return;

      if (this.history[this.history.length - 1] !== cmd) {
        this.history.push(cmd);
        if (this.history.length > 200) this.history.shift();
      }
      this.historyIdx = -1;
      this.command = '';
      this.running = true;
      const controller = new AbortController();
      this.controller = controller;

      const id = this.nextId++;
      const ts = new Date().toLocaleTimeString();
      const entry = {
        id, command: cmd, stdout: '', stderr: '', exit_code: null,
        cwd_label: this.contextLabel, ts, running: true,
      };
      this.entries.push(entry);
      this.$nextTick(() => this.scrollBottom());

      try {
        const result = await api('POST', '/terminal/exec', {
          cwd: this.cwdArg,
          command: cmd,
          timeout_ms: 120000,
        }, { signal: controller.signal });
        entry.stdout    = result.stdout || '';
        entry.stderr    = result.stderr || '';
        entry.exit_code = result.exit_code;
        entry.ok        = result.ok;
        entry.cwd_label = result.cwd_label || this.contextLabel;
      } catch (err) {
        if (controller.signal.aborted) {
          entry.stderr = 'Command stopped by operator.';
          entry.exit_code = null;
          entry.cancelled = true;
          entry.ok = false;
        } else {
          entry.stderr    = err.message || 'Request failed';
          entry.exit_code = 1;
          entry.ok        = false;
        }
      } finally {
        entry.running = false;
        entry.stopping = false;
        this.running  = false;
        if (this.controller === controller) this.controller = null;
        this.$nextTick(() => this.scrollBottom());
        this.$nextTick(() => this.$refs.cmdInput && this.$refs.cmdInput.focus());
      }
    },

    stop() {
      if (!this.running || !this.controller) return;
      const entry = this.entries.find((item) => item.running);
      if (entry) entry.stopping = true;
      this.controller.abort();
    },

    scrollBottom() {
      const el = this.$refs.output;
      if (el) el.scrollTop = el.scrollHeight;
    },

    openInChat(entry) {
      const project = this.cwdArg === '__root__' ? '__self__' : this.cwdArg;
      const prefill = [
        `I ran this command in \`${entry.cwd_label}\`:`,
        '```',
        entry.command,
        '```',
        '',
        entry.stderr ? `**Error output:**\n\`\`\`\n${entry.stderr.slice(0, 1500)}\n\`\`\`` : '',
        entry.stdout ? `**Output:**\n\`\`\`\n${entry.stdout.slice(0, 1000)}\n\`\`\`` : '',
        '',
        'Exit code: ' + entry.exit_code + '. Can you help me resolve this?',
      ].filter(l => l !== null).join('\n').trim();

      store.state.terminalChatContext = { project, prefill };
      if (navigate('#/chat') === false) {
        store.state.terminalChatContext = null;
        store.toast('Resolve or discard the unsaved editor changes before opening Chat', 'warn');
        return;
      }
      this.close();
    },

    ansi(text) {
      // Strip common ANSI escape sequences for clean display
      return String(text || '').replace(/\x1b\[[0-9;]*[mGKHF]/g, '');
    },
  },
  template: `
    <div ref="backdrop" class="modal-backdrop" @click.self="close" role="dialog" aria-modal="true" aria-labelledby="terminal-title">
      <div class="modal terminal-modal" tabindex="-1">

        <!-- Header -->
        <div class="modal-header" style="display:flex; align-items:center; gap: var(--sp-3); flex-wrap: wrap">
          <span id="terminal-title" style="font-family: monospace">⬛ Terminal</span>

          <!-- Context selector -->
          <select v-model="cwdArg" class="input input-sm" style="flex:1; min-width:160px; max-width:300px; font-family:monospace; font-size:0.8rem" :disabled="running" aria-label="Working directory context">
            <option value="__root__">orchestrator (root)</option>
            <option v-for="p in projects" :key="p.name" :value="p.name">{{ p.name }}/workspace</option>
          </select>

          <div style="flex:1"></div>
          <button class="btn btn-ghost btn-sm" @click="clear" title="Clear output (Ctrl+L)" :disabled="!entries.length">clear</button>
          <button class="btn btn-ghost btn-sm" @click="close" :disabled="running" aria-label="Close terminal">✕</button>
        </div>

        <!-- Output pane -->
        <div ref="output" class="terminal-output" aria-live="polite" aria-label="Terminal output">
          <div v-if="!entries.length" class="terminal-empty">
            <span class="muted xs">{{ contextLabel }} — type a command and press Enter</span>
          </div>

          <div v-for="entry in entries" :key="entry.id" class="terminal-entry">
            <!-- Command line -->
            <div class="terminal-cmd-line">
              <span class="terminal-prompt">{{ entry.cwd_label }} $</span>
              <span class="terminal-cmd">{{ entry.command }}</span>
              <span v-if="entry.running" class="terminal-spinner" aria-label="Running">⟳</span>
              <span v-else-if="entry.cancelled" class="badge" style="--badge-c: var(--warn)">stopped</span>
              <span v-else-if="entry.exit_code === 0" class="terminal-ok" title="Exit 0">✓</span>
              <span v-else-if="entry.exit_code !== null" class="terminal-err-badge" :title="'Exit ' + entry.exit_code">✗ {{ entry.exit_code }}</span>
            </div>

            <!-- Stdout -->
            <pre v-if="entry.stdout" class="terminal-stdout">{{ ansi(entry.stdout) }}</pre>

            <!-- Stderr -->
            <pre v-if="entry.stderr" class="terminal-stderr">{{ ansi(entry.stderr) }}</pre>

            <!-- Error action row -->
            <div v-if="!entry.running && !entry.cancelled && entry.exit_code !== 0" class="terminal-error-row">
              <span class="xs muted">Exit {{ entry.exit_code }}</span>
              <button class="btn btn-sm btn-ghost terminal-chat-btn" @click="openInChat(entry)">
                ◆ Open in Chat
              </button>
            </div>
          </div>
        </div>

        <!-- Input row -->
        <div class="terminal-input-row">
          <span class="terminal-prompt-inline">{{ promptPrefix }} $</span>
          <input
            ref="cmdInput"
            v-model="command"
            class="terminal-input"
            type="text"
            placeholder="Enter command…"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            :disabled="running"
            @keydown="onKeydown"
            aria-label="Terminal command input"
          />
          <button v-if="running" class="btn btn-danger btn-sm" @click="stop" :disabled="stopping" style="flex-shrink:0">
            <span v-if="stopping" class="terminal-spinner"></span>
            <span v-else>Stop</span>
          </button>
          <button v-else class="btn btn-primary btn-sm" @click="run" :disabled="!command.trim()" style="flex-shrink:0">
            Run
          </button>
        </div>

        <div class="modal-footer" style="padding-top: 0; border-top: none">
          <span class="xs muted">↑↓ history · Enter run · Ctrl+L clear · Esc close when idle · Stop aborts the server command · on error: Open in Chat</span>
        </div>
      </div>
    </div>
  `,
};
