// ErrorBoundary — errorCaptured wrapper so one crashing component degrades to
// an inline error card instead of blanking the whole view. The 3ec2641
// incident class (a render/compile error in ONE widget → white screen for the
// entire tab) stays closed for every component wrapped in this, not just the
// binding that happened to be fixed that day.
import { store } from '../lib/store.js';

export default {
  name: 'ErrorBoundary',
  props: {
    // Short label for the error card ("Overview tab", "Next Actions widget").
    label: { type: String, default: 'component' },
  },
  data() {
    return { error: null };
  },
  errorCaptured(err, instance, info) {
    this.error = `${err?.message || err} (${info})`;
    console.error(`[error-boundary] ${this.label} crashed:`, err, info);
    try { store.toast(`${this.label} crashed — see console`, 'err'); } catch { /* toast optional */ }
    return false; // stop propagation — the rest of the page keeps rendering
  },
  methods: {
    retry() { this.error = null; },
  },
  template: `
    <div v-if="error" class="panel" style="border:1px solid var(--red, #b91c1c); border-radius:8px; padding:12px; margin:8px 0;">
      <div style="font-weight:600; margin-bottom:4px;">⚠ {{ label }} failed to render</div>
      <div class="dim" style="font-family:monospace; font-size:12px; word-break:break-all;">{{ error }}</div>
      <button class="btn" style="margin-top:8px;" @click="retry">Retry</button>
    </div>
    <slot v-else />
  `,
};
