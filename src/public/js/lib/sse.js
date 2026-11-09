// SSE channel with ticket auth and automatic reconnect (backoff 1s→2s→5s→10s cap).
// EventSource cannot send an Authorization header, so each (re)connect first mints
// a short-lived single-use ticket via POST /api/sse-ticket.

import { api, getToken } from './api.js';

export function openStream(path, { onEvent, onStatus } = {}) {
  let es = null;
  let closed = false;
  let attempt = 0;
  let retryTimer = null;

  const status = (s) => { if (onStatus) onStatus(s); };

  async function connect() {
    if (closed) return;
    status('connecting');

    let url = path;
    if (getToken()) {
      try {
        const resp = await api('POST', '/sse-ticket');
        if (closed) return;
        url = path + (path.includes('?') ? '&' : '?') + 'ticket=' + encodeURIComponent(resp.ticket);
      } catch {
        return scheduleRetry();
      }
    }

    es = new EventSource('/api' + url);

    es.onopen = () => {
      attempt = 0;
      status('live');
    };

    es.onmessage = (ev) => {
      if (!onEvent) return;
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }
      onEvent(data);
    };

    es.onerror = () => {
      if (closed) return;
      try { es.close(); } catch { /* already closed */ }
      es = null;
      scheduleRetry();
    };
  }

  function scheduleRetry() {
    if (closed) return;
    status('down');
    const delays = [1000, 2000, 5000, 10000];
    const delay = delays[Math.min(attempt, delays.length - 1)];
    attempt++;
    retryTimer = setTimeout(connect, delay);
  }

  connect();

  return {
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (es) { try { es.close(); } catch { /* noop */ } }
      es = null;
    },
  };
}
