import { createApp } from '../vendor/vue.esm-browser.prod.js';
import App from './app.js';
import { store } from './lib/store.js';
import { initRouter } from './lib/router.js';

initRouter();
store.init();
const app = createApp(App);
// Last-resort handler: an error that escapes every ErrorBoundary must never
// white-screen the app silently (the pre-3ec2641 failure mode). Log + toast;
// Vue continues rendering whatever survives.
app.config.errorHandler = (err, instance, info) => {
  console.error('[app] unhandled component error:', err, info);
  try { store.toast(`UI error: ${err?.message || err} — see console`, 'err'); } catch { /* store may not be ready */ }
};
app.mount('#app');
