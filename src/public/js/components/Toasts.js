import { store } from '../lib/store.js';

export default {
  name: 'Toasts',
  computed: {
    toasts() { return store.state.toasts; },
  },
  template: `
    <div class="toasts" aria-live="polite">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="'toast-' + t.kind">
        <span v-if="t.project" class="toast-proj">{{ t.project }}</span>{{ t.text }}
      </div>
    </div>
  `,
};
