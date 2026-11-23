// Side peek: a page opened in a panel on the right, next to what is on
// screen — a row of a database beside its table, an event beside the
// calendar. The panel holds an ordinary page view, so everything a page can
// do works there too.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { isModalOpen } from '../lib/modal.js';
import { hasOpenPopover } from '../lib/popover.js';
import { navigate, pagePath } from './router.js';
import { emit, getPage, on } from './store.js';

let config = null; // { shell, host, mount } — given once by the shell
let current = null; // { pageId, panel, view, controller }

export function initPeek(options) {
  config = options;
  // The page was deleted (from its own menu, or by someone else): nothing to show.
  on('tree', () => {
    if (current && current.loaded && !getPage(current.pageId)) closePeek();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !current || isModalOpen() || hasOpenPopover()) return;
    // Inside the text Esc selects the block; anywhere else it closes the panel.
    if (event.target.closest?.('input, textarea, [contenteditable="true"]')) return;
    event.preventDefault();
    closePeek();
  });
}

export function peekedPageId() {
  return current?.pageId ?? null;
}

/** Save what is being written in the panel (before the page underneath changes). */
export async function flushPeek() {
  await current?.view?.flush?.();
}

export async function closePeek() {
  if (!current) return;
  const closing = current;
  current = null;
  try {
    await closing.view?.flush?.();
  } catch {
    // Closing must always work; an unsaved edit is reported by the page itself.
  }
  closing.controller.abort();
  closing.view?.destroy?.();
  closing.panel.remove();
  config.host.classList.remove('has-peek');
  emit('peek', { pageId: null, closed: closing.pageId });
}

export async function openPeek(pageId) {
  if (!config) return;
  if (current?.pageId === pageId) return;
  await closePeek();

  const topbar = h('div', { class: 'peek-topbar' });
  const body = h('div', { class: 'peek-body' });
  const panel = h(
    'aside',
    { class: 'peek', 'aria-label': 'Page preview' },
    h(
      'div',
      { class: 'peek-bar' },
      h(
        'button',
        { class: 'icon-button', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close side peek', onclick: () => closePeek() },
        icon('chevrons-right', 16),
      ),
      h(
        'button',
        {
          class: 'icon-button',
          type: 'button',
          title: 'Open as a full page',
          'aria-label': 'Open as a full page',
          onclick: async () => {
            await closePeek();
            navigate(pagePath(pageId));
          },
        },
        icon('maximize', 15),
      ),
      topbar,
    ),
    body,
  );
  const controller = new AbortController();
  const entry = { pageId, panel, view: null, controller, loaded: false };
  current = entry;
  config.host.append(panel);
  config.host.classList.add('has-peek');
  emit('peek', { pageId });

  const shell = {
    ...config.shell,
    // "Reload this page" (after locking, restoring a version…) reloads the panel.
    reloadPage: async () => {
      await closePeek();
      openPeek(pageId);
    },
  };
  const view = await config.mount({ container: body, topbar, pageId, shell, mountSignal: controller.signal, peek: true });
  if (current !== entry) {
    view.destroy?.();
    return;
  }
  entry.view = view;
  entry.loaded = true;
}
