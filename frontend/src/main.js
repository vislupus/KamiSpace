// Application shell: layout, routing, global shortcuts.
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/shell.css';
import './styles/page.css';
import './styles/editor.css';
import './styles/database.css';
import './styles/calendar.css';
import { createPage, setBeforeCreate } from './app/actions.js';
import { mountHome } from './app/home.js';
import { mountCalendar } from './app/calendar.js';
import { mountLibrary } from './app/library.js';
import { openMoveDialog } from './app/move.js';
import { mountPageView } from './app/page-view.js';
import { closePeek, flushPeek, initPeek } from './app/peek.js';
import { addLeaveGuard, navigate, pagePath, startRouter } from './app/router.js';
import { isSearchOpen, openSearch } from './app/search.js';
import { openShareDialog } from './app/share.js';
import { createSidebar } from './app/sidebar.js';
import { getPage, loadBootstrap, on, personalWorkspace, refreshTree, store } from './app/store.js';
import { mountTasks } from './app/tasks.js';
import { mountTrash } from './app/trash.js';
import { h, kbd, modKey, replace } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { isModalOpen, openModal } from './lib/modal.js';
import { closeAllPopovers, hasOpenPopover } from './lib/popover.js';
import { setThemeChoice } from './lib/theme.js';
import { storageGet, storageSet } from './lib/util.js';

const SIDEBAR_KEY = 'kamispace.sidebar';
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

function newPage() {
  return createPage({ workspaceId: personalWorkspace()?.id });
}

async function openSettings(section) {
  const module = await import('./app/settings.js');
  module.openSettings(section);
}

function openShortcuts() {
  const rows = [
    ['Search pages', 'Mod+K or Mod+P'],
    ['Link selected text', 'Mod+K'],
    ['New page', 'Alt+N'],
    ['Open in a new tab', 'Mod+click or middle button'],
    ['Back · Forward', 'Mod+[ · Mod+]'],
    ['Go to the parent page', 'Mod+Shift+U'],
    ['Show / hide sidebar', 'Mod+\\'],
    ['Light / dark', 'Mod+Shift+L'],
    ['Focus mode', 'Mod+Shift+F'],
    ['Block menu', '/'],
    ['Link to a page', '@ or [['],
    ['Select the block', 'Esc'],
    ['Block above / below (block selected)', '↑ / ↓'],
    ['Write in the selected block', 'Enter'],
    ['Delete the selected block', 'Del or Backspace'],
    ['Duplicate block', 'Mod+D'],
    ['Move block up / down', 'Mod+Shift+↑ / ↓'],
    ['Text · Heading 1 – 3', 'Mod+Shift+0 · 1 – 3'],
    ['To-do · Bulleted · Numbered list', 'Mod+Shift+4 · 5 · 6'],
    ['Toggle · Code · Sub-page', 'Mod+Shift+7 · 8 · 9'],
    ['Tick a to-do item, open / close a toggle', 'Mod+Enter'],
    ['Open / close all toggles', 'Mod+Alt+T'],
    ['Bold · Italic · Underline', 'Mod+B · I · U'],
    ['Strikethrough', 'Mod+Shift+S'],
    ['Inline code', 'Mod+E'],
    ['Highlight', 'Mod+Shift+H'],
    ['Inline equation', 'Mod+Shift+E or $$…$$'],
    ['Indent / outdent list item', 'Tab / Shift+Tab'],
    ['Move a block into / out of the toggle above', 'Tab / Shift+Tab'],
    ['Table: next cell · cell below · line break', 'Tab · Enter · Shift+Enter'],
    ['Calendar: today · year, month, week, day', 'T · Y, M, W, D'],
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
  // A page opened beside the old view does not belong to the new one.
  closePeek();
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
  } else if (route.name === 'library') {
    currentView = mountLibrary(context);
    refreshTree().catch(() => {});
  } else if (route.name === 'tasks') {
    currentView = mountTasks(context);
  } else if (route.name === 'calendar') {
    currentView = mountCalendar(context);
  } else {
    currentView = mountHome(context);
    // Keep "recently opened" fresh when coming back home.
    refreshTree().catch(() => {});
  }
}

// -- global shortcuts ---------------------------------------------------------

/**
 * Is this the key for `letter`? On a Latin layout the letter itself counts
 * (so Dvorak and AZERTY work); on any other layout — Cyrillic, for one — the
 * physical key does, because there the letter never arrives.
 */
function isLetter(event, letter) {
  const key = event.key.length === 1 ? event.key.toLowerCase() : '';
  if (key >= 'a' && key <= 'z') return key === letter;
  return event.code === `Key${letter.toUpperCase()}`;
}

/** The same for a punctuation key: the character, or the key it sits on. */
function isSymbol(event, symbol, code) {
  return event.key === symbol || event.code === code;
}

function goToParent() {
  const page = store.currentPageId ? getPage(store.currentPageId) : null;
  if (page?.parent_id && getPage(page.parent_id)) navigate(pagePath(page.parent_id));
  else navigate('/');
}

function toggleTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  setThemeChoice(dark ? 'light' : 'dark');
}

function onKeyDown(event) {
  const mod = modKey(event);
  const blocked = isModalOpen();

  if (mod && !event.shiftKey && !event.altKey && (isLetter(event, 'k') || isLetter(event, 'p'))) {
    // The editor claims Mod+K itself when there is text to link.
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (!blocked && !isSearchOpen()) openSearch();
    return;
  }
  if (blocked) return;
  const plain = mod && !event.shiftKey && !event.altKey;
  const shifted = mod && event.shiftKey && !event.altKey;
  if (plain && isSymbol(event, '\\', 'Backslash')) {
    event.preventDefault();
    toggleSidebar();
  } else if (shifted && isLetter(event, 'f')) {
    event.preventDefault();
    toggleFocusMode();
  } else if (shifted && isLetter(event, 'l')) {
    event.preventDefault();
    toggleTheme();
  } else if (shifted && isLetter(event, 'u')) {
    event.preventDefault();
    goToParent();
  } else if (plain && isSymbol(event, '/', 'Slash')) {
    event.preventDefault();
    openShortcuts();
  } else if (plain && isSymbol(event, '[', 'BracketLeft')) {
    event.preventDefault();
    history.back();
  } else if (plain && isSymbol(event, ']', 'BracketRight')) {
    event.preventDefault();
    history.forward();
  } else if (event.altKey && !event.shiftKey && !mod && event.code === 'KeyN') {
    event.preventDefault();
    newPage();
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
          h('div', { class: 'empty-title' }, 'KamiSpace could not start'),
          h('div', null, error.message),
          h('button', { class: 'button', type: 'button', onclick: () => location.reload() }, 'Try again'),
        ),
      ),
    );
    return;
  }

  sidebar = createSidebar({
    onSearch: openSearch,
    onNewPage: newPage,
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
  addLeaveGuard(() => flushPeek());
  initPeek({ shell, host: root.querySelector('.main'), mount: mountPageView });
  setBeforeCreate(async () => currentView?.flush?.());
  on('tree-stale', () => refreshTree().catch(() => {}));
  startRouter(showRoute);
}

start();
