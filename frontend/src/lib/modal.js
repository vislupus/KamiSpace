// Dialogs: generic modal, confirmation and single-field prompt.
import { h } from './dom.js';
import { icon } from './icons.js';
import { hasOpenPopover } from './popover.js';

/** Open modals, bottom to top. Escape closes the topmost one. */
const stack = [];

export function openModal({ title, content, className = '', onClose, dismissible = true }) {
  const previousFocus = document.activeElement;
  const controller = new AbortController();
  let closed = false;

  const closeButton = h(
    'button',
    { class: 'icon-button', type: 'button', 'aria-label': 'Close', onclick: () => close() },
    icon('x', 16),
  );
  const dialog = h(
    'div',
    { class: `modal ${className}`.trim(), role: 'dialog', 'aria-modal': 'true', tabIndex: -1 },
    title
      ? h('header', { class: 'modal-header' }, h('h2', { class: 'modal-title' }, title), closeButton)
      : null,
    h('div', { class: 'modal-body' }, content),
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  if (title) dialog.setAttribute('aria-label', title);

  const entry = {};

  function close(result) {
    if (closed) return;
    closed = true;
    controller.abort();
    backdrop.remove();
    stack.splice(stack.indexOf(entry), 1);
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
      previousFocus.focus({ preventScroll: true });
    }
    onClose?.(result);
  }

  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop && dismissible) close();
  });
  // Escape is handled on the document so that it works wherever the focus is
  // (a dialog whose first control is disabled has nothing to focus inside).
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || !dismissible) return;
      if (stack[stack.length - 1] !== entry || hasOpenPopover()) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    },
    { capture: true, signal: controller.signal },
  );
  dialog.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Tab') trapFocus(dialog, event);
    },
    { signal: controller.signal },
  );

  document.body.append(backdrop);
  stack.push(entry);
  const autofocus = dialog.querySelector(
    '[autofocus], input:not([disabled]), textarea, select, .modal-body button:not([disabled])',
  );
  (autofocus ?? dialog).focus({ preventScroll: true });
  return { el: dialog, close, signal: controller.signal };
}

function trapFocus(container, event) {
  const focusable = [
    ...container.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex="0"]',
    ),
  ].filter((el) => el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function isModalOpen() {
  return stack.length > 0;
}

export function confirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
}) {
  return new Promise((resolve) => {
    let result = false;
    const confirm = h(
      'button',
      {
        class: `button ${danger ? 'button-danger' : 'button-primary'}`,
        type: 'button',
        autofocus: true,
        onclick: () => {
          result = true;
          modal.close();
        },
      },
      confirmLabel,
    );
    const modal = openModal({
      title,
      className: 'modal-small',
      content: [
        h('p', { class: 'modal-text' }, message),
        h(
          'div',
          { class: 'modal-actions' },
          h('button', { class: 'button', type: 'button', onclick: () => modal.close() }, cancelLabel),
          confirm,
        ),
      ],
      onClose: () => resolve(result),
    });
    confirm.focus();
  });
}

export function promptDialog({
  title,
  label,
  value = '',
  placeholder = '',
  confirmLabel = 'Save',
  type = 'text',
  required = true,
}) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input', {
      class: 'input',
      type,
      value,
      placeholder,
      autofocus: true,
      'aria-label': label ?? title,
    });
    const form = h(
      'form',
      {
        class: 'form',
        onsubmit: (event) => {
          event.preventDefault();
          const text = input.value.trim();
          if (required && !text) return;
          result = text;
          modal.close();
        },
      },
      label ? h('label', { class: 'field-label' }, label) : null,
      input,
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { class: 'button', type: 'button', onclick: () => modal.close() }, 'Cancel'),
        h('button', { class: 'button button-primary', type: 'submit' }, confirmLabel),
      ),
    );
    const modal = openModal({
      title,
      className: 'modal-small',
      content: form,
      onClose: () => resolve(result),
    });
    input.select();
  });
}
