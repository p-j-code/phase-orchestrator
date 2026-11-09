import { store } from '../../lib/store.js';
import { fmtMoney, fmtTokens, fmtDur, fmtDate, modelShort } from '../../lib/format.js';
import { closeModal, handleModalKey, openModal } from '../../lib/modal-a11y.js';

export default {
  name: 'CallDetailModal',
  computed: {
    call() { return store.state.callDetail; },
  },
  methods: {
    fmtMoney, fmtTokens, fmtDur, fmtDate, modelShort,
    close() { store.state.callDetail = null; },
    onKey(e) { handleModalKey(this.$refs.backdrop, e, { onEscape: this.close }); },
  },
  mounted() {
    document.addEventListener('keydown', this.onKey);
    this.$nextTick(() => openModal(this.$refs.backdrop, this.$refs.closeBtn));
  },
  beforeUnmount() {
    document.removeEventListener('keydown', this.onKey);
    closeModal(this.$refs.backdrop);
  },
  template: `
    <div ref="backdrop" class="modal-backdrop" @click.self="close" role="dialog" aria-modal="true" aria-labelledby="call-detail-title">
      <div class="modal modal-lg" tabindex="-1">
        <div class="modal-header">
          <span id="call-detail-title">Call detail</span>
          <span v-if="call.is_error" class="badge" style="--badge-c: var(--err)">error</span>
          <button ref="closeBtn" data-modal-initial class="btn btn-ghost btn-sm right" @click="close" aria-label="Close">✕</button>
        </div>
        <div class="modal-body">
          <div class="grid-4">
            <div class="kpi"><span class="kpi-value">{{ fmtMoney(call.cost_usd) }}</span><span class="kpi-label">Cost</span></div>
            <div class="kpi"><span class="kpi-value">{{ fmtTokens(call.input_tokens) }}</span><span class="kpi-label">Tokens in</span></div>
            <div class="kpi"><span class="kpi-value">{{ fmtTokens(call.output_tokens) }}</span><span class="kpi-label">Tokens out</span></div>
            <div class="kpi"><span class="kpi-value">{{ fmtDur(call.duration_ms) }}</span><span class="kpi-label">Duration</span></div>
          </div>
          <div class="row-wrap small dim">
            <span v-if="call.project" class="chip">{{ call.project }}</span>
            <span class="chip" v-if="call.phase != null">phase {{ call.phase }}</span>
            <span class="chip mono">{{ modelShort(call.model) }}</span>
            <span class="chip" v-if="call.cache_read_tokens">cache read {{ fmtTokens(call.cache_read_tokens) }}</span>
            <span class="chip" v-if="call.cache_creation_tokens">cache write {{ fmtTokens(call.cache_creation_tokens) }}</span>
            <span class="chip">{{ fmtDate(call.started_at) }}</span>
          </div>
          <div class="field">
            <span class="label">Task</span>
            <div class="card-flat mono small" style="white-space: pre-wrap">{{ call.task }}</div>
          </div>
          <div class="field" v-if="call.error_message">
            <span class="label" style="color: var(--err)">Error</span>
            <div class="card-flat mono small" style="white-space: pre-wrap; color: var(--err)">{{ call.error_message }}</div>
          </div>
        </div>
      </div>
    </div>
  `,
};
