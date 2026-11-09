import { store } from '../../lib/store.js';
import { closeModal, handleModalKey, openModal } from '../../lib/modal-a11y.js';

export default {
  name: 'ConfirmModal',
  computed: {
    c() { return store.state.confirm; },
  },
  methods: {
    answer(v) { store.resolveConfirm(v); },
    onKey(e) { handleModalKey(this.$refs.backdrop, e, { onEscape: () => this.answer(false) }); },
  },
  mounted() {
    document.addEventListener('keydown', this.onKey);
    this.$nextTick(() => openModal(this.$refs.backdrop, this.$refs.cancelBtn));
  },
  beforeUnmount() {
    document.removeEventListener('keydown', this.onKey);
    closeModal(this.$refs.backdrop);
  },
  template: `
    <div ref="backdrop" class="modal-backdrop" @click.self="answer(false)" role="dialog" aria-modal="true"
         aria-labelledby="confirm-title" aria-describedby="confirm-body">
      <div class="modal" tabindex="-1">
        <div id="confirm-title" class="modal-header" :style="c.danger ? 'color: var(--err)' : ''">{{ c.title }}</div>
        <div id="confirm-body" class="modal-body">
          <div class="dim" style="white-space: pre-line">{{ c.body }}</div>
        </div>
        <div class="modal-footer">
          <button ref="cancelBtn" data-modal-initial class="btn btn-ghost" @click="answer(false)">Cancel</button>
          <button ref="confirmBtn" class="btn" :class="c.danger ? 'btn-danger' : 'btn-primary'"
                  @click="answer(true)">{{ c.confirmLabel }}</button>
        </div>
      </div>
    </div>
  `,
};
