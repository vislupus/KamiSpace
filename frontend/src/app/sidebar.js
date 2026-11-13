// Sidebar: quick actions, favourites, one tree per workspace, shared pages.
import { h, kbd } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openMenu } from '../lib/menu.js';
import { getThemeChoice, setThemeChoice } from '../lib/theme.js';
import {
  copyPageLink,
  createPage,
  duplicatePage,
  movePage,
  renamePage,
  signOut,
  toggleFavorite,
  trashPage,
} from './actions.js';
import { navigate, pagePath, parseRoute } from './router.js';
import {
  ancestorsOf,
  canCreateIn,
  childrenOf,
  descendantIds,
  getPage,
  hasChildren,
  isFavorite,
  on,
  pageTitle,
  rootPages,
  sharedRoots,
  store,
} from './store.js';
import { expandAll, isExpanded, setExpanded } from './tree-state.js';

const DRAG_TYPE = 'application/x-minddock-page';

export function createSidebar({ onSearch, onCapture, onSettings, onShortcuts, onToggle, onMove }) {
  const scroll = h('div', { class: 'sidebar-scroll', role: 'tree', 'aria-label': 'Pages' });
  let renaming = null;
  let dragging = null;
  let frame = 0;

  // -- header ---------------------------------------------------------------

  const workspaceButton = h(
    'button',
    { class: 'workspace-button', type: 'button', 'aria-haspopup': 'menu' },
    h('span', { class: 'logo-mark' }, 'M'),
    h('span', { class: 'workspace-name' }, 'MindDock'),
    icon('chevron-down', 14),
  );
  workspaceButton.addEventListener('click', () => {
    const theme = getThemeChoice();
    workspaceButton.setAttribute('aria-expanded', 'true');
    openMenu({
      anchor: workspaceButton,
      items: [
        { heading: `${store.user.display_name} · @${store.user.username}` },
        { label: 'Settings', icon: 'settings', onSelect: () => onSettings() },
        {
          label: 'Theme',
          icon: theme === 'dark' ? 'moon' : 'sun',
          submenu: [
            ['light', 'Light', 'sun'],
            ['dark', 'Dark', 'moon'],
            ['system', 'System', 'monitor'],
          ].map(([value, label, iconName]) => ({
            label,
            icon: iconName,
            checked: theme === value,
            onSelect: () => setThemeChoice(value),
          })),
        },
        { label: 'Keyboard shortcuts', icon: 'zap', hint: kbd('Mod+/'), onSelect: onShortcuts },
        { separator: true },
        { label: 'Sign out', icon: 'logout', onSelect: signOut },
      ],
      onClose: () => workspaceButton.removeAttribute('aria-expanded'),
    });
  });

  const homeLink = h(
    'a',
    { class: 'side-action', href: '/', dataset: { link: '' } },
    icon('home', 16),
    'Home',
  );
  const trashLink = h(
    'a',
    { class: 'side-action', href: '/trash', dataset: { link: '' } },
    icon('trash-2', 16),
    'Recycle bin',
  );

  const el = h(
    'aside',
    { class: 'sidebar', 'aria-label': 'Sidebar' },
    h(
      'div',
      { class: 'sidebar-top' },
      workspaceButton,
      h(
        'button',
        {
          class: 'icon-button',
          type: 'button',
          title: `Hide sidebar (${kbd('Mod+\\')})`,
          'aria-label': 'Hide sidebar',
          onclick: onToggle,
        },
        icon('chevrons-left', 16),
      ),
    ),
    h(
      'nav',
      { class: 'sidebar-actions' },
      h(
        'button',
        { class: 'side-action', type: 'button', onclick: onSearch },
        icon('search', 16),
        'Search',
        h('span', { class: 'kbd' }, kbd('Mod+K')),
      ),
      h(
        'button',
        { class: 'side-action', type: 'button', onclick: onCapture },
        icon('zap', 16),
        'Quick capture',
        h('span', { class: 'kbd' }, kbd('Alt+Shift+N')),
      ),
      homeLink,
    ),
    scroll,
    h(
      'div',
      { class: 'sidebar-bottom' },
      trashLink,
      h(
        'button',
        { class: 'side-action', type: 'button', onclick: () => onSettings() },
        icon('settings', 16),
        'Settings',
      ),
    ),
  );

  // -- rows -----------------------------------------------------------------

  function pageMenu(page, anchor, row) {
    const canEdit = page.role === 'owner' || page.role === 'editor';
    row.classList.add('has-menu');
    openMenu({
      anchor,
      items: [
        { label: 'Open in new tab', icon: 'external', onSelect: () => window.open(pagePath(page.id)) },
        {
          label: isFavorite(page.id) ? 'Remove from favorites' : 'Add to favorites',
          icon: 'star',
          onSelect: () => toggleFavorite(page.id),
        },
        { label: 'Copy link', icon: 'link', onSelect: () => copyPageLink(page.id) },
        { separator: true },
        canEdit ? { label: 'Rename', icon: 'pencil', onSelect: () => startRename(page.id) } : null,
        { label: 'Duplicate', icon: 'copy', onSelect: () => duplicatePage(page.id) },
        canEdit ? { label: 'Move to…', icon: 'move', onSelect: () => onMove(page.id) } : null,
        canEdit ? { separator: true } : null,
        canEdit
          ? { label: 'Delete', icon: 'trash-2', danger: true, onSelect: () => trashPage(page.id) }
          : null,
      ],
      onClose: () => row.classList.remove('has-menu'),
    });
  }

  function startRename(pageId) {
    renaming = pageId;
    render();
    const input = scroll.querySelector('.tree-rename');
    input?.focus();
    input?.select();
  }

  function renameInput(page) {
    const input = h('input', {
      class: 'tree-rename',
      value: page.title,
      placeholder: 'Untitled',
      'aria-label': 'Page title',
    });
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      renaming = null;
      const title = input.value.trim();
      if (commit && title !== page.title) renamePage(page.id, title);
      else render();
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') finish(true);
      if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (event) => event.stopPropagation());
    return input;
  }

  function renderRow(page, depth, activeId, { flat = false } = {}) {
    const expandable = !flat && hasChildren(page.id);
    const open = expandable && isExpanded(page.id);
    const canEdit = page.role === 'owner' || page.role === 'editor';

    const toggle = h(
      'button',
      {
        class: `tree-toggle${expandable ? '' : ' is-leaf'}`,
        type: 'button',
        tabIndex: -1,
        'aria-label': open ? 'Collapse' : 'Expand',
        'aria-expanded': expandable ? String(open) : null,
      },
      icon('chevron-right', 14),
    );
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      setExpanded(page.id, !open);
      render();
    });

    const more = h(
      'button',
      { class: 'icon-button', type: 'button', tabIndex: -1, title: 'More', 'aria-label': 'Page menu' },
      icon('more', 15),
    );
    const add = canEdit
      ? h(
          'button',
          {
            class: 'icon-button',
            type: 'button',
            tabIndex: -1,
            title: 'Add a page inside',
            'aria-label': 'Add a page inside',
          },
          icon('plus', 15),
        )
      : null;

    const row = h(
      'div',
      {
        class: `tree-row${page.id === activeId ? ' is-active' : ''}`,
        role: 'treeitem',
        tabIndex: 0,
        draggable: canEdit && !flat && renaming !== page.id,
        style: `--depth: ${depth}`,
        dataset: { id: page.id },
        'aria-current': page.id === activeId ? 'page' : null,
        'aria-expanded': expandable ? String(open) : null,
      },
      flat ? null : toggle,
      h('span', { class: 'tree-icon' }, page.icon || icon('file-text', 15)),
      renaming === page.id
        ? renameInput(page)
        : h(
            'span',
            { class: `tree-title${page.title ? '' : ' is-untitled'}`, title: pageTitle(page) },
            pageTitle(page),
          ),
      renaming === page.id ? null : h('span', { class: 'tree-actions' }, more, add),
    );

    more.addEventListener('click', (event) => {
      event.stopPropagation();
      pageMenu(page, more, row);
    });
    add?.addEventListener('click', (event) => {
      event.stopPropagation();
      createPage({ parentId: page.id });
    });
    row.addEventListener('click', () => navigate(pagePath(page.id)));
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      pageMenu(page, { x: event.clientX, y: event.clientY }, row);
    });
    row.addEventListener('keydown', (event) => onRowKey(event, page, row, expandable, open));
    if (!flat) attachDragAndDrop(row, page, canEdit);

    const nodes = [row];
    if (open) {
      for (const child of childrenOf(page.id)) nodes.push(...renderRow(child, depth + 1, activeId));
    }
    return nodes;
  }

  function onRowKey(event, page, row, expandable, open) {
    if (event.target !== row) return;
    const rows = [...scroll.querySelectorAll('.tree-row')];
    const index = rows.indexOf(row);
    switch (event.key) {
      case 'Enter':
        navigate(pagePath(page.id));
        break;
      case 'ArrowDown':
        rows[index + 1]?.focus();
        break;
      case 'ArrowUp':
        rows[index - 1]?.focus();
        break;
      case 'ArrowRight':
        if (expandable && !open) {
          setExpanded(page.id, true);
          render();
          scroll.querySelector(`.tree-row[data-id="${page.id}"]`)?.focus();
        }
        break;
      case 'ArrowLeft':
        if (open) {
          setExpanded(page.id, false);
          render();
          scroll.querySelector(`.tree-row[data-id="${page.id}"]`)?.focus();
        }
        break;
      case 'F2':
        if (page.role !== 'viewer') startRename(page.id);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  // -- drag and drop --------------------------------------------------------

  function clearDropMarks() {
    for (const marked of scroll.querySelectorAll('[data-drop]')) delete marked.dataset.drop;
  }

  function dropZone(event, row, target) {
    const rect = row.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    const canNest = target.role === 'owner' || target.role === 'editor';
    // Reordering among the roots of a share is not possible for a guest.
    const canReorder = !(target.shared && target.parent_id === null);
    if (canReorder && ratio < 0.28) return 'before';
    if (canReorder && ratio > 0.72) return 'after';
    return canNest ? 'inside' : null;
  }

  function attachDragAndDrop(row, page, canEdit) {
    if (canEdit) {
      row.addEventListener('dragstart', (event) => {
        dragging = { id: page.id, blocked: new Set([page.id, ...descendantIds(page.id)]) };
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(DRAG_TYPE, String(page.id));
        event.dataTransfer.setData('text/plain', pageTitle(page));
        row.classList.add('is-dragging');
      });
      row.addEventListener('dragend', () => {
        dragging = null;
        row.classList.remove('is-dragging');
        clearDropMarks();
      });
    }
    row.addEventListener('dragover', (event) => {
      if (!dragging || dragging.blocked.has(page.id)) return;
      const zone = dropZone(event, row, page);
      clearDropMarks();
      if (!zone) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      row.dataset.drop = zone;
    });
    row.addEventListener('dragleave', () => {
      delete row.dataset.drop;
    });
    row.addEventListener('drop', (event) => {
      const zone = row.dataset.drop;
      clearDropMarks();
      if (!dragging || !zone) return;
      event.preventDefault();
      const sourceId = dragging.id;
      dragging = null;
      if (zone === 'inside') {
        movePage(sourceId, { parent_id: page.id });
      } else {
        movePage(sourceId, {
          parent_id: page.parent_id,
          workspace_id: page.workspace_id,
          [zone === 'before' ? 'before_id' : 'after_id']: page.id,
        });
      }
    });
  }

  // -- sections -------------------------------------------------------------

  function section(label, rows, { action = null, emptyText = null, dropWorkspace = null } = {}) {
    const heading = h(
      'div',
      { class: 'tree-heading' },
      h('span', { class: 'tree-heading-label', title: label }, label),
      action,
    );
    if (dropWorkspace) {
      // Dropping on a workspace heading moves the page to its top level.
      heading.addEventListener('dragover', (event) => {
        if (!dragging) return;
        event.preventDefault();
        heading.dataset.drop = 'inside';
      });
      heading.addEventListener('dragleave', () => delete heading.dataset.drop);
      heading.addEventListener('drop', (event) => {
        delete heading.dataset.drop;
        if (!dragging) return;
        event.preventDefault();
        movePage(dragging.id, { parent_id: null, workspace_id: dropWorkspace });
        dragging = null;
      });
    }
    return h(
      'section',
      { class: 'tree-section' },
      heading,
      rows.length ? rows : emptyText ? h('div', { class: 'tree-empty' }, emptyText) : null,
    );
  }

  function render() {
    frame = 0;
    const route = parseRoute();
    const activeId = route.name === 'page' ? route.pageId : null;
    homeLink.classList.toggle('is-active', route.name === 'home');
    trashLink.classList.toggle('is-active', route.name === 'trash');
    const scrollTop = scroll.scrollTop;
    const focusedId = document.activeElement?.closest?.('.tree-row')?.dataset.id;
    const sections = [];

    const favorites = store.favorites.map(getPage).filter(Boolean);
    if (favorites.length) {
      sections.push(
        section(
          'Favorites',
          favorites.flatMap((page) => renderRow(page, 0, activeId, { flat: true })),
        ),
      );
    }

    for (const workspace of store.workspaces) {
      const creatable = canCreateIn(workspace);
      const addButton = creatable
        ? h(
            'button',
            {
              class: 'icon-button',
              type: 'button',
              title: `New page in ${workspace.name}`,
              'aria-label': `New page in ${workspace.name}`,
              onclick: () => createPage({ workspaceId: workspace.id }),
            },
            icon('plus', 15),
          )
        : null;
      sections.push(
        section(
          workspace.kind === 'personal' ? 'Private' : workspace.name,
          rootPages(workspace.id).flatMap((page) => renderRow(page, 0, activeId)),
          {
            action: addButton,
            emptyText: creatable ? 'No pages yet' : 'Nothing here yet',
            dropWorkspace: creatable ? workspace.id : null,
          },
        ),
      );
    }

    const shared = sharedRoots();
    if (shared.length) {
      sections.push(
        section(
          'Shared with me',
          shared.flatMap((page) => renderRow(page, 0, activeId)),
        ),
      );
    }

    scroll.replaceChildren(...sections);
    scroll.scrollTop = scrollTop;
    if (focusedId && !renaming) scroll.querySelector(`.tree-row[data-id="${focusedId}"]`)?.focus();
  }

  function scheduleRender() {
    if (renaming !== null) return; // do not disturb an inline rename
    if (!frame) frame = requestAnimationFrame(render);
  }

  /** Make sure the open page is visible in the tree. */
  function reveal(pageId) {
    const changed = expandAll(ancestorsOf(pageId).map((page) => page.id));
    if (changed) render();
    requestAnimationFrame(() => {
      scroll.querySelector('.tree-row.is-active')?.scrollIntoView({ block: 'nearest' });
    });
  }

  on('tree', scheduleRender);
  render();
  return { el, render: scheduleRender, reveal };
}
