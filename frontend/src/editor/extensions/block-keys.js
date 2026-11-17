// Keyboard shortcuts for moving, duplicating and nesting blocks.
import { Extension } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';
import {
  currentBlockPos,
  duplicateBlock,
  indentIntoToggle,
  isItem,
  moveBlockByKeyboard,
  outdentFromToggle,
} from '../block-ops.js';

/** Places where Tab already means something else. */
function tabIsTaken(editor) {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.spec.code || isItem(node) || node.type.name === 'table') return true;
  }
  return false;
}

export const BlockKeys = Extension.create({
  name: 'blockKeys',
  // After the list, table and code-block bindings for Tab.
  priority: 50,

  addOptions() {
    return { onExitTop: null };
  },

  addKeyboardShortcuts() {
    const move = (direction) => () => {
      if (!this.editor.isEditable) return false;
      moveBlockByKeyboard(this.editor, direction);
      return true;
    };
    return {
      'Alt-Shift-ArrowUp': move(-1),
      'Alt-Shift-ArrowDown': move(1),
      'Mod-d': () => {
        if (!this.editor.isEditable) return false;
        return duplicateBlock(this.editor, currentBlockPos(this.editor.state));
      },
      // Tab nests the block under the toggle above it; Shift+Tab takes it out.
      // Elsewhere Tab does nothing — it must never throw the focus out of the page.
      Tab: () => {
        if (!this.editor.isEditable || tabIsTaken(this.editor)) return false;
        indentIntoToggle(this.editor);
        return true;
      },
      'Shift-Tab': () => {
        if (!this.editor.isEditable || tabIsTaken(this.editor)) return false;
        outdentFromToggle(this.editor);
        return true;
      },
      // From the very first line, ArrowUp leaves the editor for the title.
      ArrowUp: () => {
        const { selection } = this.editor.state;
        const { $from } = selection;
        if (!selection.empty || !this.options.onExitTop || $from.depth === 0) return false;
        const first = Selection.atStart(this.editor.state.doc);
        if ($from.start() !== first.$from.start()) return false;
        if (!this.editor.view.endOfTextblock('up')) return false;
        this.options.onExitTop();
        return true;
      },
    };
  },
});
