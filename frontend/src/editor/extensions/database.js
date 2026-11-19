// A database shown inside a page (table or board). The database itself is a
// sub-page of the page it sits in; this block only says where to show it.
// Drawing and editing it is the application's job (see app/database), which
// keeps the editor independent of the rest of the app.
import { Node, mergeAttributes } from '@tiptap/core';
import { h } from '../../lib/dom.js';
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

/** Create a database inside the current page and show it at the caret. */
export async function insertDatabase(editor, view = 'table') {
  const created = await appContext(editor).createDatabase(view);
  if (!created || editor.isDestroyed) return;
  insertBlockNode(editor, editor.schema.nodes.database.create({ pageId: created.id }));
}
