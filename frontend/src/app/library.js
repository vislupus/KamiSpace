// Library: every page you can open, in one sortable, filterable list.
import { h, replace } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { timeAgo } from '../lib/util.js';
import { createPage } from './actions.js';
import { importMarkdown } from './import.js';
import { pagePath } from './router.js';
import { ancestorsOf, isFavorite, on, pageTitle, personalWorkspace, store } from './store.js';

const SORTS = {
  updated: { label: 'Last edited', compare: (a, b) => b.updated_at.localeCompare(a.updated_at) },
  title: { label: 'Title', compare: (a, b) => pageTitle(a).localeCompare(pageTitle(b)) },
};

export function mountLibrary({ container, topbar }) {
  document.title = 'Library · KamiSpace';
  replace(topbar, h('nav', { class: 'breadcrumbs' }, h('span', { class: 'crumb' }, 'Library')));

  let filter = 'all';
  let sort = 'updated';
  let query = '';
  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Filter by title…',
    'aria-label': 'Filter pages',
  });
  const filters = h('div', { class: 'segmented library-filters', role: 'group', 'aria-label': 'Show' });
  const sortSelect = h(
    'select',
    { class: 'select', 'aria-label': 'Sort by' },
    Object.entries(SORTS).map(([value, entry]) => h('option', { value }, entry.label)),
  );
  const list = h('div', { class: 'library-list' });
  const count = h('span', { class: 'muted' });

  function locationOf(page) {
    const workspace = store.workspaces.find((entry) => entry.id === page.workspace_id);
    const root = page.shared
      ? 'Shared with me'
      : workspace?.kind === 'personal'
        ? 'Private'
        : (workspace?.name ?? '');
    return [root, ...ancestorsOf(page.id).map(pageTitle)].join(' / ');
  }

  function matches(page) {
    if (query && !pageTitle(page).toLowerCase().includes(query)) return false;
    if (filter === 'all') return true;
    if (filter === 'favorites') return isFavorite(page.id);
    if (filter === 'shared') return page.shared;
    return !page.shared && page.workspace_id === Number(filter);
  }

  function renderFilters() {
    const options = [
      ['all', 'All'],
      ...store.workspaces.map((workspace) => [
        String(workspace.id),
        workspace.kind === 'personal' ? 'Private' : workspace.name,
      ]),
      ['shared', 'Shared with me'],
      ['favorites', 'Favorites'],
    ];
    replace(
      filters,
      options.map(([value, label]) =>
        h(
          'button',
          {
            type: 'button',
            'aria-pressed': String(filter === value),
            onclick: () => {
              filter = value;
              render();
            },
          },
          label,
        ),
      ),
    );
  }

  function render() {
    renderFilters();
    // Rows of databases are listed inside their database, not here.
    const pages = [...store.pages.values()]
      .filter((page) => !page.is_row)
      .filter(matches)
      .sort(SORTS[sort].compare);
    count.textContent = `${pages.length} page${pages.length === 1 ? '' : 's'}`;
    if (!pages.length) {
      replace(
        list,
        h(
          'div',
          { class: 'empty' },
          icon('library', 28),
          h('div', { class: 'empty-title' }, store.pages.size ? 'No pages match' : 'No pages yet'),
          h('div', null, store.pages.size ? 'Try another filter.' : 'Create your first page to fill the library.'),
        ),
      );
      return;
    }
    replace(
      list,
      pages.slice(0, 500).map((page) =>
        h(
          'a',
          { class: 'list-row library-row', href: pagePath(page.id), dataset: { link: '' } },
          h('span', { class: 'tree-icon' }, page.icon || icon('file-text', 16)),
          h(
            'div',
            { class: 'list-main' },
            h('div', { class: 'list-title' }, pageTitle(page)),
            h('div', { class: 'list-sub' }, locationOf(page)),
          ),
          isFavorite(page.id) ? h('span', { class: 'library-star' }, icon('star', 14)) : null,
          h('span', { class: 'library-date muted' }, timeAgo(page.updated_at)),
        ),
      ),
    );
  }

  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    render();
  });
  sortSelect.addEventListener('change', () => {
    sort = sortSelect.value;
    render();
  });

  replace(
    container,
    h(
      'div',
      { class: 'listing library' },
      h(
        'div',
        { class: 'listing-head' },
        h('h1', null, 'Library'),
        h(
          'button',
          {
            class: 'button button-small',
            type: 'button',
            onclick: () => importMarkdown({ workspaceId: personalWorkspace()?.id }),
          },
          icon('file-up', 14),
          'Import Markdown',
        ),
        h(
          'button',
          {
            class: 'button button-small button-primary',
            type: 'button',
            onclick: () => createPage({ workspaceId: personalWorkspace()?.id }),
          },
          icon('plus', 14),
          'New page',
        ),
      ),
      h('p', { class: 'settings-desc' }, 'Every page you can open: your private pages, team workspaces and pages shared with you.'),
      h('div', { class: 'library-toolbar' }, search, sortSelect, count),
      filters,
      list,
    ),
  );
  render();
  const unsubscribe = on('tree', render);
  return { flush: async () => {}, destroy: unsubscribe };
}
