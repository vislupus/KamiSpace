// Keyboard shortcuts for moving and duplicating blocks.
import { Extension } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';
import { currentBlockPos, duplicateBlock, moveNode, topLevelBlockPos } from '../block-ops.js';

export const BlockKeys = Extension.create({
  name: 'blockKeys',

  addOptions() {
    return { onExitTop: null };
  },

  addKeyboardShortcuts() {
    const move = (direction) => () => {
      if (!this.editor.isEditable) return false;
      const itemPos = currentBlockPos(this.editor.state);
      // Inside a list, move the item; at the edge of the list, move the list.
      if (moveNode(this.editor, itemPos, direction)) return true;
      const blockPos = topLevelBlockPos(this.editor.state);
      if (blockPos !== itemPos) moveNode(this.editor, blockPos, direction);
      return true;
    };
    return {
      'Alt-Shift-ArrowUp': move(-1),
      'Alt-Shift-ArrowDown': move(1),
      'Mod-d': () => {
        if (!this.editor.isEditable) return false;
        return duplicateBlock(this.editor, topLevelBlockPos(this.editor.state));
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
