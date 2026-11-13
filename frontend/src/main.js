// Application shell: layout, routing, global shortcuts.
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/shell.css';
import './styles/page.css';
import './styles/editor.css';
import { createPage } from './app/actions.js';
import { openCapture } from './app/capture.js';
import { mountHome } from './app/home.js';
import { openMoveDialog } from './app/move.js';
import { mountPageView } from './app/page-view.js';
import { addLeaveGuard, startRouter } from './app/router.js';
import { isSearchOpen, openSearch } from './app/search.js';
import { openShareDialog } from './app/share.js';
import { createSidebar } from './app/sidebar.js';
import { loadBootstrap, on, personalWorkspace, refreshTree, store } from './app/store.js';
import { mountTrash } from './app/trash.js';
import { h, kbd, modKey, replace } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { isModalOpen, openModal } from './lib/modal.js';
import { closeAllPopovers, hasOpenPopover } from './lib/popover.js';
import './lib/theme.js';
import { storageGet, storageSet } from './lib/util.js';

const SIDEBAR_KEY = 'minddock.sidebar';
const root = document.getElementById('app');
const smallScreen = window.matchMedia('(max-width: 860px)');

let currentView = null;
let mountController = null;
let currentRoute = null;

// -- layout -------------------------------------------------------------------

const topbarContent = h('div', { style: 'display: contents' });
const view = h('div', { class: 'view', id: 'view' });
const openSidebarButton = h(
  'button',
  {
    class: 'icon-button sidebar-open-button',
    type: 'button',
    title: `Show sidebar (${kbd('Mod+\\')})`,
    'aria-label': 'Show sidebar',
  },
  icon('menu', 17),
);

function setSidebar(open, { remember = true } = {}) {
  root.dataset.sidebar = open ? 'open' : 'closed';
  if (remember && !smallScreen.matches) storageSet(SIDEBAR_KEY, open);
}

function toggleSidebar() {
  setSidebar(root.dataset.sidebar !== 'open');
}

function isFocusMode() {
  return root.classList.contains('is-focus');
}

function toggleFocusMode() {
  root.classList.toggle('is-focus');
  currentView?.focusEditor?.();
}

async function openSettings(section) {
  const module = await import('./app/settings.js');
  module.openSettings(section);
}

function openShortcuts() {
  const rows = [
    ['Search pages', 'Mod+K'],
    ['Link selected text', 'Mod+K'],
    ['Quick capture', 'Alt+Shift+N'],
    ['New page', 'Alt+N'],
    ['Show / hide sidebar', 'Mod+\\'],
    ['Focus mode', 'Mod+Shift+F'],
    ['Block menu', '/'],
    ['Bold · Italic · Underline', 'Mod+B · I · U'],
    ['Strikethrough', 'Mod+Shift+S'],
    ['Inline code', 'Mod+E'],
    ['Heading 1 – 3', 'Mod+Alt+1 – 3'],
    ['Move block up / down', 'Alt+Shift+↑ / ↓'],
    ['Duplicate block', 'Mod+D'],
    ['Indent / outdent list item', 'Tab / Shift+Tab'],
    ['Undo · Redo', 'Mod+Z · Mod+Shift+Z'],
  ];
  openModal({
    title: 'Keyboard shortcuts',
    content: h(
      'div',
      { class: 'shortcut-list' },
      rows.flatMap(([label, combo]) => [
        h('span', null, label),
        h('span', { class: 'kbd' }, combo.split(' ').map((part) => kbd(part)).join(' ')),
      ]),
    ),
  });
}

const shell = {
  isFocusMode,
  toggleFocusMode,
  openSearch,
  openCapture,
  openShare: openShareDialog,
  openMove: openMoveDialog,
  reloadPage: () => showRoute(currentRoute, { force: true }),
};

// -- routing ------------------------------------------------------------------

function showRoute(route, { force = false } = {}) {
  if (
    !force &&
    currentRoute &&
    route.name === currentRoute.name &&
    route.pageId === currentRoute.pageId
  ) {
    return;
  }
  currentRoute = route;
  closeAllPopovers();
  mountController?.abort();
  mountController = new AbortController();
  currentView?.destroy();
  currentView = null;
  store.currentPageId = route.name === 'page' ? route.pageId : null;
  if (smallScreen.matches) setSidebar(false, { remember: false });
  sidebar.render();

  const context = { container: view, topbar: topbarContent, shell };
  if (route.name === 'page') {
    const controller = mountController;
    sidebar.reveal(route.pageId);
    mountPageView({ ...context, pageId: route.pageId, mountSignal: controller.signal }).then(
      (mounted) => {
        if (controller.signal.aborted) mounted.destroy();
        else currentView = mounted;
      },
    );
  } else if (route.name === 'trash') {
    currentView = mountTrash(context);
  } else {
    currentView = mountHome(context);
    // Keep "recently opened" fresh when coming back home.
    refreshTree().catch(() => {});
  }
}

// -- global shortcuts ---------------------------------------------------------

function onKeyDown(event) {
  const mod = modKey(event);
  const key = event.key.toLowerCase();
  const blocked = isModalOpen();

  if (mod && !event.shiftKey && !event.altKey && key === 'k') {
    // The editor claims Mod+K itself when there is text to link.
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (!blocked && !isSearchOpen()) openSearch();
    return;
  }
  if (blocked) return;
  if (mod && !event.shiftKey && !event.altKey && event.key === '\\') {
    event.preventDefault();
    toggleSidebar();
  } else if (mod && event.shiftKey && key === 'f') {
    event.preventDefault();
    toggleFocusMode();
  } else if (mod && event.key === '/') {
    event.preventDefault();
    openShortcuts();
  } else if (event.altKey && event.shiftKey && !mod && event.code === 'KeyN') {
    event.preventDefault();
    openCapture();
  } else if (event.altKey && !event.shiftKey && !mod && event.code === 'KeyN') {
    event.preventDefault();
    createPage({ workspaceId: personalWorkspace()?.id });
  }
}

/**
 * Escape leaves focus mode. Checked in the capture phase because the editor
 * consumes Escape itself; menus and dialogs that are open get it first.
 */
function onEscapeCapture(event) {
  if (event.key !== 'Escape' || !isFocusMode()) return;
  if (isModalOpen() || hasOpenPopover() || document.querySelector('.slash-menu')) return;
  toggleFocusMode();
}

// -- start --------------------------------------------------------------------

let sidebar;

async function start() {
  try {
    await loadBootstrap();
  } catch (error) {
    replace(
      root,
      h(
        'div',
        { class: 'boot' },
        h(
          'div',
          { class: 'empty' },
          icon('offline', 28),
          h('div', { class: 'empty-title' }, 'MindDock could not start'),
          h('div', null, error.message),
          h('button', { class: 'button', type: 'button', onclick: () => location.reload() }, 'Try again'),
        ),
      ),
    );
    return;
  }

  sidebar = createSidebar({
    onSearch: openSearch,
    onCapture: openCapture,
    onSettings: openSettings,
    onShortcuts: openShortcuts,
    onToggle: toggleSidebar,
    onMove: openMoveDialog,
    // On small screens the sidebar is an overlay: picking a page closes it,
    // even when that page is already open.
    onOpenPage: () => {
      if (smallScreen.matches) setSidebar(false, { remember: false });
    },
  });
  const backdrop = h('div', { class: 'sidebar-backdrop' });
  backdrop.addEventListener('click', () => setSidebar(false, { remember: false }));
  openSidebarButton.addEventListener('click', () => setSidebar(true));

  replace(
    root,
    sidebar.el,
    backdrop,
    h('div', { class: 'main' }, h('header', { class: 'topbar' }, openSidebarButton, topbarContent), view),
  );
  setSidebar(smallScreen.matches ? false : storageGet(SIDEBAR_KEY, true), { remember: false });
  smallScreen.addEventListener('change', () => {
    setSidebar(smallScreen.matches ? false : storageGet(SIDEBAR_KEY, true), { remember: false });
  });

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keydown', onEscapeCapture, true);
  addLeaveGuard(() => currentView?.flush?.());
  on('tree-stale', () => refreshTree().catch(() => {}));
  startRouter(showRoute);
}

start();
