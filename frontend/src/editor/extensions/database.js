// A database shown inside a page (table or board). The database itself is a
// sub-page of the page it sits in; this block only says where to show it.
// Drawing and editing it is the application's job (see app/database), which
// keeps the editor independent of the rest of the app.
import { Node, mergeAttributes } from '@tiptap/core';
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { openPopover } from '../../lib/popover.js';
import { insertBlockNode } from '../url-prompt.js';
import { appContext } from './app-context.js';

export const DatabaseBlock = Node.create({
  name: 'database',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      pageId: {
        default: null,
        parseHTML: (element) => Number(element.getAttribute('data-database')) || null,
        renderHTML: (attributes) => ({ 'data-database': attributes.pageId }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-database]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'database-block' })];
  },

  renderMarkdown: (node) => `[Database](/p/${node.attrs?.pageId})`,

  addNodeView() {
    return ({ node, editor }) => {
      const dom = h('div', { class: 'database-block', contentEditable: 'false' });
      const { mountDatabase } = appContext(editor);
      const mounted = mountDatabase
        ? mountDatabase({ container: dom, databaseId: node.attrs.pageId, inline: true })
        : null;
      if (!mounted) dom.append(h('div', { class: 'db-missing' }, 'Database'));
      return {
        dom,
        update: (updated) => updated.type === node.type && updated.attrs.pageId === node.attrs.pageId,
        // Everything inside belongs to the database, not to the text editor.
        stopEvent: () => true,
        ignoreMutation: () => true,
        destroy: () => mounted?.destroy(),
      };
    };
  },
});

/**
 * Create a database in the current page. Inline, it is shown right here, at
 * the caret; as a full page it is a page of its own that is only linked
 * here, and it opens straight away, as in Notion.
 */
export async function insertDatabase(editor, view = 'table', { fullPage = false } = {}) {
  const context = appContext(editor);
  const created = await context.createDatabase(view);
  if (!created || editor.isDestroyed) return;
  if (fullPage) {
    insertBlockNode(editor, editor.schema.nodes.pageLink.create({ pageId: created.id }));
    context.openPage(created.id);
    return;
  }
  insertBlockNode(editor, editor.schema.nodes.database.create({ pageId: created.id }));
}

/**
 * Show a database that lives somewhere else: choose one, and it is drawn
 * here too. Both places show the same rows.
 */
export function insertLinkedDatabase(editor) {
  const context = appContext(editor);
  const { view } = editor;
  const databases = context
    .listPages()
    .filter((page) => page.kind === 'database')
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  const search = h('input', { class: 'input', type: 'text', placeholder: 'Search databases…', 'aria-label': 'Search databases' });
  const list = h('div', { class: 'db-link-list', role: 'listbox' });
  let active = 0;
  let shown = [];

  const choose = (page) => {
    popover.close();
    if (editor.isDestroyed) return;
    insertBlockNode(editor, editor.schema.nodes.database.create({ pageId: page.id }));
  };
  const where = (page) => {
    const parent = page.parent_id ? context.getPage(page.parent_id) : null;
    return parent ? `in ${parent.title || 'Untitled'}` : '';
  };
  function draw() {
    const needle = search.value.trim().toLowerCase();
    shown = databases.filter((page) => !needle || (page.title || 'untitled').toLowerCase().includes(needle)).slice(0, 50);
    active = Math.min(active, Math.max(shown.length - 1, 0));
    list.replaceChildren(
      ...(shown.length
        ? shown.map((page, index) =>
            h(
              'div',
              {
                class: `menu-item${index === active ? ' is-active' : ''}`,
                role: 'option',
                onclick: () => choose(page),
              },
              page.icon ? h('span', { class: 'menu-emoji' }, page.icon) : icon('database', 16),
              h('span', { class: 'menu-label' }, page.title || 'Untitled', h('span', { class: 'menu-description' }, where(page))),
            ),
          )
        : [h('div', { class: 'db-link-empty' }, databases.length ? 'No database with that name.' : 'There are no databases yet. Create one with /database.')]),
    );
    list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }
  search.addEventListener('input', () => {
    active = 0;
    draw();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (shown.length) active = (active + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      draw();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (shown[active]) choose(shown[active]);
    }
  });
  draw();
  const popover = openPopover({
    anchor: () => {
      const at = view.coordsAtPos(view.state.selection.from);
      return new DOMRect(at.left, at.top, 0, at.bottom - at.top);
    },
    placement: 'bottom-start',
    className: 'menu-popover',
    content: h('div', { class: 'menu db-link-picker' }, h('div', { class: 'db-property-name' }, search), list),
  });
  search.focus();
}
