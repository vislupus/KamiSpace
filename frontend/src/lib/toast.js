// Small, unobtrusive notifications.
import { h } from './dom.js';
import { icon } from './icons.js';

let container = null;

function ensureContainer() {
  if (!container) {
    container = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(container);
  }
  return container;
}

export function toast(message, { type = 'info', action, duration = 4000 } = {}) {
  const iconName = { error: 'alert', success: 'check-circle', info: 'info' }[type] ?? 'info';
  let timer = null;
  const el = h(
    'div',
    { class: `toast toast-${type}` },
    icon(iconName, 16),
    h('span', { class: 'toast-message' }, message),
    action
      ? h(
          'button',
          {
            class: 'toast-action',
            type: 'button',
            onclick: () => {
              dismiss();
              action.onClick();
            },
          },
          action.label,
        )
      : null,
  );
  function dismiss() {
    clearTimeout(timer);
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 160);
  }
  ensureContainer().append(el);
  timer = setTimeout(dismiss, type === 'error' ? Math.max(duration, 6000) : duration);
  return { dismiss };
}

export function toastError(error, fallback = 'Something went wrong') {
  if (error?.name === 'AbortError') return;
  toast(error?.message || fallback, { type: 'error' });
}
