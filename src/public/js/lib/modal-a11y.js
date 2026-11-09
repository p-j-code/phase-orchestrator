// Shared modal accessibility helpers. Vue renders each modal as a direct child
// of #app, so the active dialog can isolate the rest of the application while
// keeping nested confirms (for example, NAS sync confirmations) functional.

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const stack = [];
const originalState = new Map();

function appChildren() {
  return Array.from(document.getElementById('app')?.children || []);
}

function remember(el) {
  if (originalState.has(el)) return;
  originalState.set(el, {
    inert: el.hasAttribute('inert'),
    ariaHidden: el.getAttribute('aria-hidden'),
  });
}

function setIsolated(el, isolated) {
  remember(el);
  if (isolated) {
    el.setAttribute('inert', '');
    el.setAttribute('aria-hidden', 'true');
    return;
  }
  el.removeAttribute('inert');
  el.removeAttribute('aria-hidden');
}

function updateIsolation() {
  const top = stack[stack.length - 1]?.root || null;
  if (!top) {
    for (const [el, state] of originalState) {
      if (!el.isConnected) continue;
      if (state.inert) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
      if (state.ariaHidden == null) el.removeAttribute('aria-hidden');
      else el.setAttribute('aria-hidden', state.ariaHidden);
    }
    originalState.clear();
    document.body.classList.remove('modal-open');
    return;
  }

  document.body.classList.add('modal-open');
  for (const el of appChildren()) {
    const isTopContainer = el === top || el.contains(top);
    setIsolated(el, !isTopContainer);
  }
}

function focusables(root) {
  return Array.from(root?.querySelectorAll(FOCUSABLE) || [])
    .filter((el) => !el.hidden && el.getAttribute('aria-hidden') !== 'true' && el.getClientRects().length > 0);
}

function focusInitial(root, preferred) {
  const target = preferred || root?.querySelector('[data-modal-initial]') || focusables(root)[0];
  if (target?.focus) target.focus({ preventScroll: true });
  else {
    const dialog = root?.querySelector('.modal') || root;
    if (dialog) {
      dialog.setAttribute('tabindex', '-1');
      dialog.focus({ preventScroll: true });
    }
  }
}

export function openModal(root, preferredFocus = null) {
  if (!root || stack.some((entry) => entry.root === root)) return;
  stack.push({ root, previousFocus: document.activeElement });
  updateIsolation();
  requestAnimationFrame(() => focusInitial(root, preferredFocus));
}

export function closeModal(root) {
  const index = stack.findIndex((entry) => entry.root === root);
  if (index < 0) return;
  const [{ previousFocus }] = stack.splice(index, 1);
  updateIsolation();
  requestAnimationFrame(() => {
    if (previousFocus?.isConnected && !previousFocus.closest?.('[inert]')) {
      previousFocus.focus?.({ preventScroll: true });
    }
  });
}

export function isTopModal(root) {
  return stack[stack.length - 1]?.root === root;
}

// Focus-only primitives are also used by responsive navigation drawers. Their
// background branches are component-specific, while Tab/Escape behavior is
// identical to a dialog.
export function focusContained(root, preferredFocus = null) {
  requestAnimationFrame(() => focusInitial(root, preferredFocus));
}

export function isolateForOverlay(elements) {
  const states = [...new Set((elements || []).filter(Boolean))].map((el) => ({
    el,
    inert: el.hasAttribute('inert'),
    ariaHidden: el.getAttribute('aria-hidden'),
  }));
  for (const { el } of states) {
    el.setAttribute('inert', '');
    el.setAttribute('aria-hidden', 'true');
  }
  return () => {
    for (const { el, inert, ariaHidden } of states) {
      if (!el.isConnected) continue;
      if (inert) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
      if (ariaHidden == null) el.removeAttribute('aria-hidden');
      else el.setAttribute('aria-hidden', ariaHidden);
    }
  };
}

export function handleContainedKey(root, event, { onEscape, escapeDisabled = false } = {}) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    if (!escapeDisabled) {
      event.preventDefault();
      onEscape?.();
    }
    return true;
  }
  if (event.key !== 'Tab') return false;

  const items = focusables(root);
  if (!items.length) {
    event.preventDefault();
    focusInitial(root);
    return true;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !root.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
  return true;
}

export function handleModalKey(root, event, options = {}) {
  if (!isTopModal(root)) return false;
  return handleContainedKey(root, event, options);
}
