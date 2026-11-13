// "Move to…" dialog: pick a new parent page or a workspace root.
import { h, replace } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openModal } from '../lib/modal.js';
import { movePage } from './actions.js';
import {
  ancestorsOf,
  canCreateIn,
  descendantIds,
  getPage,
  pageTitle,
  store,
} from './store.js';

export function openMoveDialog(pageId) {
  const page = getPage(pageId);
  if (!page) return;
  const blocked = new Set([pageId, ...descendantIds(pageId)]);
  const input = h('input', {
    class: 'palette-input',
    placeholder: `Move “${pageTitle(page)}” to…`,
    autofocus: true,
    autocomplete: 'off',
    'aria-label': 'Destination',
  });
  const results = h('div', { class: 'palette-results', role: 'listbox' });
  let items = [];
  let active = 0;

  function destinations(query) {
    const needle = query.toLowerCase();
    const found = [];
    for (const workspace of store.workspaces) {
      if (!canCreateIn(workspace)) continue;
      const label = workspace.kind === 'personal' ? 'Private' : workspace.name;
      if (!needle || label.toLowerCase().includes(needle)) {
        found.push({
          title: `Top level of ${label}`,
          iconName: workspace.kind === 'personal' ? 'lock' : 'building',
          destination: { parent_id: null, workspace_id: workspace.id },
          disabled: page.parent_id === null && page.workspace_id === workspace.id,
        });
      }
    }
    const pages = [];
    for (const candidate of store.pages.values()) {
      if (blocked.has(candidate.id)) continue;
      if (candidate.role !== 'owner' && candidate.role !== 'editor') continue;
      if (needle && !pageTitle(candidate).toLowerCase().includes(needle)) continue;
      pages.push(candidate);
    }
    pages.sort((a, b) => pageTitle(a).localeCompare(pageTitle(b)));
    for (const candidate of pages.slice(0, 40)) {
      found.push({
        title: pageTitle(candidate),
        emoji: candidate.icon,
        iconName: 'file-text',
        path: ancestorsOf(candidate.id).map(pageTitle).join(' / '),
        destination: { parent_id: candidate.id },
        disabled: candidate.id === page.parent_id,
      });
    }
    return found;
  }

  async function choose(item) {
    if (!item || item.disabled) return;
    modal.close();
    await movePage(pageId, item.destination);
  }

  function setActive(index) {
    active = index;
    [...results.children].forEach((row, i) => {
      row.classList.toggle('is-active', i === active);
      if (i === active) row.scrollIntoView({ block: 'nearest' });
    });
  }

  function render() {
    items = destinations(input.value.trim());
    active = Math.max(0, items.findIndex((item) => !item.disabled));
    replace(
      results,
      items.length
        ? items.map((item, index) => {
            const row = h(
              'div',
              {
                class: `palette-item${item.disabled ? ' is-disabled' : ''}`,
                role: 'option',
                style: item.disabled ? 'opacity: .45; cursor: default' : null,
              },
              h('span', { class: 'palette-icon' }, item.emoji || icon(item.iconName, 16)),
              h(
                'div',
                { class: 'palette-main' },
                h(
                  'div',
                  { class: 'palette-title' },
                  item.title,
                  item.disabled ? h('span', { class: 'palette-path' }, 'current location') : null,
                ),
                item.path ? h('div', { class: 'palette-snippet' }, item.path) : null,
              ),
            );
            row.addEventListener('click', () => choose(item));
            row.addEventListener('mousemove', () => {
              if (active !== index) setActive(index);
            });
            return row;
          })
        : h('div', { class: 'palette-empty' }, 'No matching destinations'),
    );
    setActive(active);
  }

  input.addEventListener('input', render);
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
    content: [h('div', { class: 'palette-input-row' }, icon('move', 17), input), results],
  });
  modal.el.setAttribute('aria-label', 'Move page');
  render();
  input.focus();
}
