// Side-by-side columns. A "columns" block holds 2–5 "column" blocks, and each
// column holds ordinary blocks.
import { Node, createBlockMarkdownSpec, mergeAttributes } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

export const MAX_COLUMNS = 5;

function findColumns($pos) {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === 'columns') {
      return { node: $pos.node(depth), pos: $pos.before(depth), depth };
    }
  }
  return null;
}

export const Columns = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column{2,5}',
  defining: true,
  isolating: true,

  parseHTML() {
    return [{ tag: 'div[data-columns]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-columns': node.childCount,
        class: 'columns',
      }),
      0,
    ];
  },
  ...createBlockMarkdownSpec({ nodeName: 'columns', content: 'block' }),

  addCommands() {
    return {
      /** Insert `count` empty columns at the caret (replacing an empty line). */
      insertColumns:
        (count = 2) =>
        ({ state, dispatch }) => {
          const { schema, selection } = state;
          const { $from } = selection;
          if (findColumns($from)) return false; // no columns inside columns
          const columns = this.type.create(
            null,
            Array.from({ length: count }, () =>
              schema.nodes.column.create(null, schema.nodes.paragraph.create()),
            ),
          );
          const block = $from.parent;
          const emptyLine = block.type.name === 'paragraph' && block.content.size === 0;
          let from;
          let to;
          if (emptyLine && $from.depth > 0) {
            const container = $from.node(-1);
            const index = $from.index(-1);
            if (!container.canReplaceWith(index, index + 1, this.type)) return false;
            from = $from.before();
            to = $from.after();
          } else {
            // Otherwise place the columns after the current top-level block.
            from = $from.depth === 0 ? $from.pos : $from.after(1);
            to = from;
          }
          if (dispatch) {
            const tr = state.tr.replaceWith(from, to, columns);
            tr.setSelection(TextSelection.near(tr.doc.resolve(from + 2)));
            dispatch(tr.scrollIntoView());
          }
          return true;
        },
      addColumn:
        () =>
        ({ state, dispatch }) => {
          const found = findColumns(state.selection.$from);
          if (!found || found.node.childCount >= MAX_COLUMNS) return false;
          if (dispatch) {
            const end = found.pos + found.node.nodeSize - 1;
            const column = state.schema.nodes.column.create(
              null,
              state.schema.nodes.paragraph.create(),
            );
            dispatch(state.tr.insert(end, column).scrollIntoView());
          }
          return true;
        },
      /** Put the content of all columns back into a single flow. */
      unsetColumns:
        () =>
        ({ state, dispatch }) => {
          const found = findColumns(state.selection.$from);
          if (!found) return false;
          if (dispatch) {
            const blocks = [];
            found.node.forEach((column) => column.forEach((block) => blocks.push(block)));
            dispatch(
              state.tr
                .replaceWith(found.pos, found.pos + found.node.nodeSize, blocks)
                .scrollIntoView(),
            );
          }
          return true;
        },
    };
  },
});

export const Column = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,

  parseHTML() {
    return [{ tag: 'div[data-column]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-column': '', class: 'column' }), 0];
  },
  ...createBlockMarkdownSpec({ nodeName: 'column', content: 'block' }),
});

/** Position of the columns block that starts at or contains `pos`, if any. */
export function columnsAt(state, pos) {
  const node = state.doc.nodeAt(pos);
  return node?.type.name === 'columns' ? { node, pos } : null;
}
