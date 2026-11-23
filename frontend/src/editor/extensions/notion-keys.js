// Keyboard habits from Notion:
//   Esc                    select the block the caret is in
//   ↑ / ↓ (block selected) select the block above / below
//   Enter (block selected) write in it again
//   Delete / Backspace     delete the selected block
//   Ctrl+Shift+0 … 9       turn the block into text, heading 1–3, to-do, bulleted
//                          list, numbered list, toggle, code, sub-page
//                          (Ctrl+Alt+0 … 9 does the same)
//   Ctrl+Shift+↑ / ↓       move the block
//   Ctrl+Enter             tick a to-do item
//   Ctrl+Alt+T             open or close every toggle
import { Extension } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import {
  adjacentBlockPos,
  convertBlock,
  currentBlockPos,
  isBlockNode,
  moveBlockByKeyboard,
} from '../block-ops.js';
import { insertSubPage } from './page-link.js';

const KINDS = [
  { kind: 'text' },
  { kind: 'heading', level: 1 },
  { kind: 'heading', level: 2 },
  { kind: 'heading', level: 3 },
  { kind: 'todo' },
  { kind: 'bullet' },
  { kind: 'numbered' },
  { kind: 'toggle', level: 0 },
  { kind: 'code' },
];

/** The selected block, when a whole block is selected. */
function selectedBlock(state) {
  const { selection } = state;
  if (!(selection instanceof NodeSelection)) return null;
  return isBlockNode(selection.node, selection.$from.parent) ? { node: selection.node, pos: selection.from } : null;
}

function selectBlock(view, pos) {
  const { state } = view;
  const node = state.doc.nodeAt(pos);
  if (!node || !NodeSelection.isSelectable(node)) return false;
  view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)).scrollIntoView());
  return true;
}

export const NotionKeys = Extension.create({
  name: 'notionKeys',
  // Ahead of the defaults these keys replace (Ctrl+Shift+7/8/9 are lists there).
  priority: 1000,

  addKeyboardShortcuts() {
    const editor = this.editor;
    const turnInto = (index) => () => {
      if (!editor.isEditable) return false;
      if (index === 9) {
        insertSubPage(editor);
        return true;
      }
      return convertBlock(editor, currentBlockPos(editor.state), KINDS[index]);
    };
    const move = (direction) => () => {
      if (!editor.isEditable) return false;
      moveBlockByKeyboard(editor, direction);
      return true;
    };
    const step = (direction) => () => {
      const block = selectedBlock(editor.state);
      if (!block) return false;
      const next = adjacentBlockPos(editor.state.doc, block.pos, direction);
      return next === null ? false : selectBlock(editor.view, next);
    };
    const shortcuts = {
      Escape: () => {
        const { state, view } = editor;
        if (!editor.isEditable || selectedBlock(state)) return false;
        return selectBlock(view, currentBlockPos(state));
      },
      ArrowUp: step(-1),
      ArrowDown: step(1),
      Enter: () => {
        const block = selectedBlock(editor.state);
        // Pictures, embeds and the like have nothing to write in.
        if (!block || block.node.isAtom || block.node.type.name === 'table') return false;
        const { state, view } = editor;
        const end = Selection.near(state.doc.resolve(block.pos + block.node.nodeSize - 1), -1);
        view.dispatch(state.tr.setSelection(end).scrollIntoView());
        return true;
      },
      'Mod-Shift-ArrowUp': move(-1),
      'Mod-Shift-ArrowDown': move(1),
      // Tick or untick the to-do item the caret is in.
      'Mod-Enter': () => {
        const { state, view } = editor;
        const { $from } = state.selection;
        for (let depth = $from.depth; depth > 0; depth -= 1) {
          const node = $from.node(depth);
          if (node.type.name !== 'taskItem') continue;
          if (!editor.isEditable) return false;
          const pos = $from.before(depth);
          view.dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked }));
          return true;
        }
        return false;
      },
      // Open every toggle, or close them all when they are open already.
      'Mod-Alt-t': () => {
        if (!editor.isEditable) return false;
        const { state, view } = editor;
        const toggles = [];
        state.doc.descendants((node, pos) => {
          if (node.type.name === 'details') toggles.push({ node, pos });
          return true;
        });
        if (!toggles.length) return false;
        const open = !toggles.every(({ node }) => node.attrs.open);
        const tr = state.tr;
        for (const { node, pos } of toggles) tr.setNodeMarkup(pos, undefined, { ...node.attrs, open });
        if (!open) tr.setSelection(Selection.near(tr.doc.resolve(tr.mapping.map(state.selection.from)), -1));
        view.dispatch(tr);
        return true;
      },
    };
    for (let index = 0; index <= 9; index += 1) {
      shortcuts[`Mod-Shift-${index}`] = turnInto(index);
      shortcuts[`Mod-Alt-${index}`] = turnInto(index);
    }
    return shortcuts;
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('notionKeys'),
        props: {
          // Typing while a text block is selected continues that block; it
          // does not wipe it out.
          handleTextInput(view, _from, _to, text) {
            const block = selectedBlock(view.state);
            if (!block || block.node.isAtom || !block.node.textContent) return false;
            const end = Selection.near(view.state.doc.resolve(block.pos + block.node.nodeSize - 1), -1);
            view.dispatch(view.state.tr.setSelection(end).insertText(text).scrollIntoView());
            return true;
          },
        },
      }),
    ];
  },
});
