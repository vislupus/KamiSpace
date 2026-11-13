// Global search palette (Ctrl/Cmd+K).
import { api } from '../lib/api.js';
import { h, replace } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openModal } from '../lib/modal.js';
import { debounce } from '../lib/util.js';
import { createPage } from './actions.js';
import { navigate, pagePath } from './router.js';
import { ancestorsOf, getPage, pageTitle, personalWorkspace, store } from './store.js';

const MARK_START = '';
const MARK_END = '';
let open = null;

/** Turn the server's marked snippet into text and <mark> nodes (never HTML). */
function highlighted(snippet) {
  const nodes = [];
  for (const part of snippet.split(MARK_START)) {
    const end = part.indexOf(MARK_END);
    if (end === -1) {
      if (part) nodes.push(part);
    } else {
      nodes.push(h('mark', null, part.slice(0, end)));
      const rest = part.slice(end + 1);
      if (rest) nodes.push(rest);
    }
  }
  return nodes;
}

export function openSearch() {
  if (open) return;
  let items = [];
  let active = 0;
  let request = null;

  const input = h('input', {
    class: 'palette-input',
    type: 'text',
    placeholder: 'Search pages…',
    autofocus: true,
    spellcheck: false,
    autocomplete: 'off',
    role: 'combobox',
    'aria-label': 'Search pages',
    'aria-expanded': 'true',
    'aria-controls': 'palette-results',
  });
  const results = h('div', { class: 'palette-results', id: 'palette-results', role: 'listbox' });

  function recentItems() {
    return store.recents
      .map(getPage)
      .filter(Boolean)
      .slice(0, 8)
      .map((page) => ({
        kind: 'page',
        id: page.id,
        title: pageTitle(page),
        icon: page.icon,
        path: ancestorsOf(page.id).map(pageTitle),
        snippet: '',
      }));
  }

  function choose(item) {
    if (!item) return;
    modal.close();
    if (item.kind === 'create') {
      createPage({ workspaceId: personalWorkspace()?.id, title: item.query });
    } else {
      navigate(pagePath(item.id));
    }
  }

  function setActive(index) {
    active = index;
    [...results.querySelectorAll('.palette-item')].forEach((row, i) => {
      row.classList.toggle('is-active', i === active);
      row.setAttribute('aria-selected', String(i === active));
      if (i === active) row.scrollIntoView({ block: 'nearest' });
    });
  }

  function render(heading) {
    if (!items.length) {
      replace(results, h('div', { class: 'palette-empty' }, 'No pages found'));
      return;
    }
    replace(
      results,
      heading ? h('div', { class: 'menu-heading' }, heading) : null,
      items.map((item, index) => {
        const row = h(
          'div',
          { class: 'palette-item', role: 'option' },
          h(
            'span',
            { class: 'palette-icon' },
            item.kind === 'create' ? icon('plus', 16) : item.icon || icon('file-text', 16),
          ),
          h(
            'div',
            { class: 'palette-main' },
            h(
              'div',
              { class: 'palette-title' },
              item.kind === 'create' ? `Create page “${item.query}”` : item.title || 'Untitled',
              item.path?.length ? h('span', { class: 'palette-path' }, item.path.join(' / ')) : null,
            ),
            item.snippet ? h('div', { class: 'palette-snippet' }, highlighted(item.snippet)) : null,
          ),
        );
        row.addEventListener('click', () => choose(item));
        row.addEventListener('mousemove', () => {
          if (active !== index) setActive(index);
        });
        return row;
      }),
    );
    setActive(Math.min(active, items.length - 1));
  }

  const search = debounce(async (query) => {
    request?.abort();
    request = new AbortController();
    try {
      const data = await api.get(`/api/search?q=${encodeURIComponent(query)}`, {
        signal: request.signal,
      });
      if (input.value.trim() !== query) return;
      items = data.results.map((result) => ({ kind: 'page', ...result }));
      items.push({ kind: 'create', query });
      active = 0;
      render();
    } catch (error) {
      if (error?.name !== 'AbortError') {
        replace(results, h('div', { class: 'palette-empty' }, error.message));
      }
    }
  }, 110);

  function onInput() {
    const query = input.value.trim();
    if (!query) {
      search.cancel();
      request?.abort();
      items = recentItems();
      active = 0;
      if (items.length) render('Recently opened');
      else replace(results, h('div', { class: 'palette-empty' }, 'Type to search your pages'));
      return;
    }
    search(query);
  }

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (items.length) setActive((active + 1) % items.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (items.length) setActive((active - 1 + items.length) % items.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(items[active]);
    }
  });

  const modal = openModal({
    className: 'palette',
    content: [
      h('div', { class: 'palette-input-row' }, icon('search', 17), input),
      results,
      h(
        'div',
        { class: 'palette-footer' },
        h('span', null, h('span', { class: 'kbd' }, '↑↓'), ' navigate'),
        h('span', null, h('span', { class: 'kbd' }, '↵'), ' open'),
        h('span', null, h('span', { class: 'kbd' }, 'Esc'), ' close'),
      ),
    ],
    onClose: () => {
      open = null;
      search.cancel();
      request?.abort();
    },
  });
  modal.el.setAttribute('aria-label', 'Search');
  open = modal;
  onInput();
  input.focus();
}

export function isSearchOpen() {
  return open !== null;
}
