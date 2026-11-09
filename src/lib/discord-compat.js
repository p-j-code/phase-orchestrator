// Discord compatibility layer — provides a grammy-like ctx object from a
// Discord.js interaction, and a DiscordKeyboard that mirrors InlineKeyboard's API.
//
// Usage in handlers (server.js routing layer):
//   const ctx = makeCtx(interaction);   // slash command or button interaction
//   const ctx = makeMessageCtx(message); // MessageCreate event (capture mode)
//
// This lets handler code use ctx.reply(), ctx.from.id, ctx.callbackQuery.data, etc.
// without knowing whether it's talking to Telegram or Discord.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { htmlToDiscord, truncateId, splitForDiscord } from './discord-fmt.js';

// ─── DiscordKeyboard ─────────────────────────────────────────────────────────
// Drop-in replacement for grammy's InlineKeyboard. Build with .text() and .row();
// call .toComponents() to get Discord ActionRow array for interaction.reply({components}).

export class DiscordKeyboard {
  constructor() {
    this._rows = [[]];
  }

  text(label, customId) {
    const safeId = truncateId(String(customId));
    const safeLabel = String(label).slice(0, 80);
    const btn = new ButtonBuilder()
      .setCustomId(safeId)
      .setLabel(safeLabel)
      .setStyle(ButtonStyle.Primary);
    const last = this._rows[this._rows.length - 1];
    if (last.length >= 5) {
      this._rows.push([btn]);
    } else {
      last.push(btn);
    }
    return this;
  }

  row() {
    if (this._rows[this._rows.length - 1].length > 0) {
      this._rows.push([]);
    }
    return this;
  }

  toComponents() {
    const rows = this._rows.filter((r) => r.length > 0);
    if (rows.length > 5) {
      // Discord hard-caps at 5 action rows; the extra rows are dropped. Warn so
      // an over-full keyboard (e.g. a per-item picker that outgrew 25 buttons)
      // surfaces in logs instead of silently hiding buttons from the user.
      const dropped = rows.slice(5).reduce((n, r) => n + r.length, 0);
      console.warn(`[discord-compat] keyboard has ${rows.length} rows (>5) — dropping ${dropped} button(s) past the cap; use a select menu for lists this long`);
    }
    return rows
      .slice(0, 5) // Discord max 5 action rows
      .map((r) => new ActionRowBuilder().addComponents(r));
  }
}

// Named alias used by handlers that imported InlineKeyboard from grammy
export { DiscordKeyboard as InlineKeyboard };

// ─── DiscordSelectMenu ───────────────────────────────────────────────────────
// Dropdown picker — renders as a Discord string-select menu (1 action row).
// Holds up to 25 options. Use for list commands (/projects, etc.) so the user
// picks from a dropdown rather than from a row of buttons.

export class DiscordSelectMenu {
  constructor({ customId, placeholder = 'Select…', minValues = 1, maxValues = 1 } = {}) {
    this._customId = truncateId(String(customId));
    this._placeholder = String(placeholder).slice(0, 150);
    this._minValues = minValues;
    this._maxValues = maxValues;
    this._options = [];
  }

  option(label, value, description) {
    if (this._options.length >= 25) return this; // Discord max
    const opt = new StringSelectMenuOptionBuilder()
      .setLabel(String(label).slice(0, 100))
      .setValue(String(value).slice(0, 100));
    if (description) opt.setDescription(String(description).slice(0, 100));
    this._options.push(opt);
    return this;
  }

  toComponents() {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(this._customId)
      .setPlaceholder(this._placeholder)
      .setMinValues(this._minValues)
      .setMaxValues(this._maxValues)
      .setOptions(this._options);
    return [new ActionRowBuilder().addComponents(menu)];
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function convertOpts(opts) {
  if (!opts) return {};
  const out = {};
  if (opts.reply_markup instanceof DiscordKeyboard || opts.reply_markup instanceof DiscordSelectMenu) {
    out.components = opts.reply_markup.toComponents();
  } else if (Array.isArray(opts.reply_markup)) {
    out.components = opts.reply_markup;
  }
  return out;
}

// ─── makeCtx — wraps a Discord slash-command or button interaction ───────────

export function makeCtx(interaction) {
  let responded = false;
  const isBtn = interaction.isButton?.() || false;
  const isSelect = interaction.isStringSelectMenu?.() || false;

  // server.js always calls deferReply() (slash) or deferUpdate() (button) before
  // creating ctx, so interaction.deferred is always true here. We use editReply()
  // for the first send and followUp() for all subsequent sends.
  async function send(text, opts = {}) {
    const content = htmlToDiscord(text);
    const extra = convertOpts(opts);

    // Auto-split messages that exceed Discord's 2000-char limit.
    // Buttons only go on the last chunk.
    const chunks = splitForDiscord(content);

    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const payload = { content: chunks[i], ...(isLast ? extra : {}) };

      if (!responded) {
        responded = true;
        if (interaction.deferred) {
          await interaction.editReply(payload);
        } else {
          // Fallback: interaction was not deferred (should not happen with our server.js)
          await (isBtn ? interaction.update(payload) : interaction.reply(payload));
        }
      } else {
        await interaction.followUp(payload);
      }
    }
  }

  return {
    from: {
      id: interaction.user.id,
      username: interaction.user.username,
      first_name: interaction.user.displayName || interaction.user.username,
    },
    // "match" mimics grammy ctx.match — the raw argument string after the command.
    // Set ctx._matchOverride to inject args from a callback that delegates to a
    // slash-command handler (e.g. bug:promote-sev callback → handleBugPromote).
    get match() {
      if (this._matchOverride !== undefined) return this._matchOverride;
      if (isSelect) return (interaction.values?.[0] || '').trim();
      return (interaction.options?.getString?.('args') || '').trim();
    },
    // Accept the grammy-style `ctx.match = value` assignment too — 8 callback
    // bridges in discord-handlers.js use it directly. Without this setter, strict
    // mode (this is an ESM module) throws "Cannot set property match … only a
    // getter", silently killing triage/home/qa/predict/preview/git callbacks.
    set match(v) { this._matchOverride = v; },
    chat: { id: interaction.channelId },
    message: { message_id: interaction.message?.id },

    // callbackQuery.data is the button's customId (equivalent to Telegram callback data)
    callbackQuery: isBtn ? { data: interaction.customId } : null,

    async reply(text, opts = {}) {
      return send(text, opts);
    },

    async editMessageText(text, opts = {}) {
      // Always use editReply — server.js has already deferred every interaction.
      const content = htmlToDiscord(text);
      const extra = convertOpts(opts);
      responded = true;
      await interaction.editReply({ content, ...extra });
    },

    async editMessageReplyMarkup({ reply_markup } = {}) {
      const extra = convertOpts({ reply_markup });
      await interaction.editReply(extra);
    },

    async replyWithDocument(file, opts = {}) {
      const filePath = file?.path ?? file;
      const attachment = new AttachmentBuilder(filePath);
      const payload = { files: [attachment] };
      if (opts.caption) payload.content = opts.caption;
      if (!responded) {
        responded = true;
        // Always deferred — use editReply for the first file send
        await interaction.editReply(payload);
      } else {
        await interaction.followUp(payload);
      }
    },

    async deferReply() {
      // no-op: server.js always defers before creating ctx
    },

    // no-op — server.js uses deferUpdate() to acknowledge button clicks
    async answerCallbackQuery() {},
  };
}

// ─── makeMessageCtx — wraps a Discord MessageCreate event ───────────────────
// Used for capture mode (handleMessage). Messages are NOT interactions.

export function makeMessageCtx(message) {
  return {
    from: { id: message.author.id },
    message: { text: message.content, message_id: message.id },
    chat: { id: message.channelId },
    callbackQuery: null,

    async reply(text, opts = {}) {
      const content = htmlToDiscord(text);
      const extra = convertOpts(opts);
      await message.reply({ content, ...extra });
    },

    async editMessageText(text) {
      // Can't edit the original user message; send a follow-up
      await message.reply({ content: htmlToDiscord(text) });
    },

    async replyWithDocument(file, opts = {}) {
      const filePath = file?.path ?? file;
      const attachment = new AttachmentBuilder(filePath);
      const payload = { files: [attachment] };
      if (opts.caption) payload.content = opts.caption;
      await message.reply(payload);
    },

    async answerCallbackQuery() {},
    async deferReply() {},
  };
}
