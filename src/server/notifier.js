// Notifier — posts messages to allowlisted users when events happen.
// Discord version: sends DMs to allowlisted Discord users, falls back to
// the configured notification channel when DM delivery fails.
//
// The tg_users table stores Discord user IDs in the telegram_user_id column
// (legacy column name; values are now Discord snowflake strings).

import { listUsers } from './job-queue.js';
import { htmlToDiscord } from '../lib/discord-fmt.js';

export class Notifier {
  constructor(client, channelId) {
    this.client = client;
    this.channelId = channelId;
    this.platform = 'discord';
  }

  /**
   * Send a notification to the relevant allowlisted user(s).
   *
   * Returns { delivered, total } — `delivered` is the number of recipients
   * actually reached. requireConfirmation() uses delivered===0 to detect an
   * unreachable notifier and write a fallback log instead of waiting forever.
   * Existing callers that ignore the return value are unaffected; notify
   * never throws.
   */
  async notify({ text, job, replyMarkup = null }) {
    const allUsers = listUsers();
    if (allUsers.length === 0) {
      console.log('[notifier] no allowlisted users, skipping:', text.slice(0, 80));
      return { delivered: 0, total: 0 };
    }

    // Narrow to the requesting user when available; broadcast otherwise.
    const requestedBy = job?.requested_by ? String(job.requested_by) : null;
    const targets = requestedBy
      ? allUsers.filter((u) => String(u.telegram_user_id) === requestedBy)
      : allUsers;
    const recipients = targets.length > 0 ? targets : allUsers;

    const content = htmlToDiscord(text);
    const payload = { content };
    if (replyMarkup) {
      payload.components = Array.isArray(replyMarkup) ? replyMarkup : [replyMarkup];
    }

    let delivered = 0;
    let channelFallbackNeeded = false;
    for (const u of recipients) {
      const userId = String(u.telegram_user_id);
      try {
        const discordUser = await this.client.users.fetch(userId);
        await discordUser.send(payload);
        delivered++;
      } catch (_dmErr) {
        // DMs may be blocked; the shared channel is a broadcast fallback — mark
        // that at least one recipient was unreachable, but post to the channel
        // only ONCE below (posting per-failed-DM would spam the shared channel
        // and inflate `delivered` with duplicate sends of the same message).
        channelFallbackNeeded = true;
      }
    }
    if (channelFallbackNeeded) {
      try {
        const channel = await this.client.channels.fetch(this.channelId);
        if (channel?.isTextBased()) {
          await channel.send(payload);
          delivered++;
        }
      } catch (chanErr) {
        console.error(`[notifier] channel fallback failed: ${chanErr.message}`);
      }
    }
    return { delivered, total: recipients.length };
  }

  // Used before the Discord client is ready (server startup before login)
  async notifyConsoleOnly(text) {
    console.log('[notifier:console]', text);
  }
}
