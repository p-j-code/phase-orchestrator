// Telegram Notifier — sends messages to allowlisted users via grammy.
//
// Returns { delivered, total } so requireConfirmation() can detect
// an unreachable notifier (delivered===0) and write a fallback log.

import { listUsers } from './job-queue.js';

export class TelegramNotifier {
  constructor(bot) {
    this.bot = bot;
    this.platform = 'telegram';
  }

  async notify({ text, job, parseMode = 'HTML', replyMarkup = null }) {
    const allUsers = listUsers();
    if (allUsers.length === 0) {
      console.log('[notifier] no allowlisted users, skipping:', text.slice(0, 80));
      return { delivered: 0, total: 0 };
    }

    const requestedBy = job?.requested_by ? Number(job.requested_by) : null;
    const targets = requestedBy
      ? allUsers.filter((u) => u.telegram_user_id === requestedBy)
      : allUsers;
    const recipients = targets.length > 0 ? targets : allUsers;

    const opts = { parse_mode: parseMode };
    if (replyMarkup) opts.reply_markup = replyMarkup;

    let delivered = 0;
    for (const u of recipients) {
      try {
        await this.bot.api.sendMessage(u.telegram_user_id, text, opts);
        delivered++;
      } catch (err) {
        console.error(`[notifier] failed to message ${u.telegram_user_id}: ${err.message}`);
      }
    }
    return { delivered, total: recipients.length };
  }

  async notifyConsoleOnly(text) {
    console.log('[notifier:console]', text);
  }
}
