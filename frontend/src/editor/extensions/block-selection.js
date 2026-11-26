// Selecting several blocks, the way Notion shows it: once a selection leaves
// the block it started in, whole blocks are selected — each one marked with
// its own rectangle — instead of ragged runs of text.
//
//   drag across blocks, Ctrl+A        whole blocks
//   Shift+↓ / Shift+↑                 one block more, or one less
//   (with a block selected by Esc, the same keys start such a selection)
//
// The selection in the document is made to match what is shown: it runs from
// the start of the first block to the end of the last, so copying, deleting
// and formatting act on exactly the marked blocks.
import { Extension } from '@tiptap/core';
import { AllSelection, NodeSelection, Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { CONTAINER_TYPES, LIST_TYPES, isBlockNode } from '../block-ops.js';

const key = new PluginKey('blockSelection');
const CELLS = new Set(['tableCell', 'tableHeader']);
const TABLE_PARTS = new Set(['table', 'tableRow']);

/** A node whose children are blocks of their own (or list items). */
const holdsBlocks = (node) => CONTAINER_TYPES.has(node.type.name) || LIST_TYPES.has(node.type.name) || CELLS.has(node.type.name);

/**
 * The blocks a selection covers, when it covers more than the inside of one
 * text block: [{ pos, node }], or null for an ordinary text selection.
 */
export function selectedBlocks(state) {
  const { selection, doc } = state;
  // A selected block or selected table cells have their own look.
  if (selection.empty || selection instanceof NodeSelection || selection.$anchorCell) return null;
  const { $from, $to, from, to } = selection;
  let parent = doc;
  let parentStart = 0;
  let startIndex = 0;
  let endIndex = doc.childCount;
  if (!(selection instanceof AllSelection)) {
    if ($from.sameParent($to)) return null;
    const range = $from.blockRange($to);
    if (!range) return null;
    let { depth } = range;
    ({ parent, startIndex, endIndex } = range);
    // Parts of one block (the lines of a list item, the summary and the body
    // of a toggle): the block itself is what is selected.
    while (depth > 0 && !holdsBlocks(parent)) {
      if (TABLE_PARTS.has(parent.type.name)) return null;
      startIndex = $from.index(depth - 1);
      endIndex = startIndex + 1;
      depth -= 1;
      parent = $from.node(depth);
    }
    if (TABLE_PARTS.has(parent.type.name)) return null;
    parentStart = $from.start(depth);
  }
  const blocks = [];
  parent.forEach((child, offset, index) => {
    if (index < startIndex || index >= endIndex) return;
    const pos = parentStart + offset;
    if (!LIST_TYPES.has(child.type.name)) {
      blocks.push({ pos, node: child });
      return;
    }
    // A list is not a block; its items are. Only the ones that are touched.
    child.forEach((item, itemOffset) => {
      const itemPos = pos + 1 + itemOffset;
      if (selection instanceof AllSelection || (itemPos < to && itemPos + item.nodeSize > from)) {
        blocks.push({ pos: itemPos, node: item });
      }
    });
  });
  return blocks.length ? blocks : null;
}

/** A text selection from the start of the first block to the end of the last. */
function across(doc, from, to, forward = true) {
  const start = Selection.findFrom(doc.resolve(from), 1, true);
  const end = Selection.findFrom(doc.resolve(to), -1, true);
  if (!start || !end || start.from >= end.to) return null;
  return TextSelection.create(doc, forward ? start.from : end.to, forward ? end.to : start.from);
}

/** The selection widened to the whole of its blocks, or null when it is that already. */
function wholeBlocks(state, blocks) {
  const { selection, doc } = state;
  if (selection instanceof AllSelection) return null;
  const last = blocks[blocks.length - 1];
  const wide = across(doc, blocks[0].pos, last.pos + last.node.nodeSize, selection.anchor <= selection.head);
  if (!wide) return null;
  // Never narrower than what was selected (a picture at the edge has no text to end in).
  const from = Math.min(wide.from, selection.from);
  const to = Math.max(wide.to, selection.to);
  if (from === selection.from && to === selection.to) return null;
  return selection.anchor <= selection.head ? TextSelection.create(doc, from, to) : TextSelection.create(doc, to, from);
}

export const BlockSelection = Extension.create({
  name: 'blockSelection',
  priority: 1001,

  addKeyboardShortcuts() {
    const editor = this.editor;
    /** Shift+↓ (1) or Shift+↑ (-1): one block more at the moving end, or one less. */
    const step = (direction) => () => {
      const { state, view } = editor;
      const { selection, doc } = state;
      let blocks = selectedBlocks(state);
      let forward = selection.anchor <= selection.head;
      if (!blocks) {
        if (!(selection instanceof NodeSelection) || !isBlockNode(selection.node, selection.$from.parent)) return false;
        blocks = [{ pos: selection.from, node: selection.node }];
      }
      if (blocks.length === 1) forward = direction > 0;
      const last = blocks[blocks.length - 1];
      let from = blocks[0].pos;
      let to = last.pos + last.node.nodeSize;
      let next = null;
      if ((direction > 0) === forward) {
        // Growing: take in the block after the last (or before the first).
        // Past the end of a list or a toggle, that is the block that follows it.
        for (let attempt = 0; attempt < 4 && !next; attempt += 1) {
          let $edge = doc.resolve(direction > 0 ? to : from);
          while (!(direction > 0 ? $edge.nodeAfter : $edge.nodeBefore) && $edge.depth > 0) {
            $edge = doc.resolve(direction > 0 ? $edge.after() : $edge.before());
          }
          const neighbour = direction > 0 ? $edge.nodeAfter : $edge.nodeBefore;
          if (!neighbour) return true;
          // Of a list, one item at a time: the items are the blocks.
          const item = LIST_TYPES.has(neighbour.type.name) ? (direction > 0 ? neighbour.firstChild : neighbour.lastChild) : null;
          if (direction > 0) to = item ? $edge.pos + 1 + item.nodeSize : $edge.pos + neighbour.nodeSize;
          else from = item ? $edge.pos - 1 - item.nodeSize : $edge.pos - neighbour.nodeSize;
          const candidate = across(doc, from, to, forward);
          // A picture has no text to stop in: go on to the block after it.
          if (candidate && !candidate.eq(selection)) next = candidate;
        }
      } else if (blocks.length === 2) {
        // Shrinking to one block: that block, selected.
        const kept = forward ? blocks[0] : blocks[1];
        next = NodeSelection.isSelectable(kept.node)
          ? NodeSelection.create(doc, kept.pos)
          : across(doc, kept.pos, kept.pos + kept.node.nodeSize, forward);
      } else {
        const inner = forward ? blocks[blocks.length - 2] : blocks[1];
        if (forward) to = inner.pos + inner.node.nodeSize;
        else from = inner.pos;
        next = across(doc, from, to, forward);
      }
      if (!next) return true;
      view.dispatch(state.tr.setSelection(next).scrollIntoView());
      return true;
    };
    return { 'Shift-ArrowDown': step(1), 'Shift-ArrowUp': step(-1) };
  },

  addProseMirrorPlugins() {
    // While the mouse button is down the browser owns the selection; it is
    // widened when the button is released. On touch screens the selection is
    // moved by handles and left alone.
    let pressed = false;
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    return [
      new Plugin({
        key,
        state: {
          init: (_config, state) => selectedBlocks(state),
          apply: (tr, value, _old, state) => (tr.selectionSet || tr.docChanged ? selectedBlocks(state) : value),
        },
        appendTransaction(transactions, _oldState, newState) {
          if (pressed || coarse) return null;
          if (!transactions.some((tr) => tr.selectionSet)) return null;
          const blocks = key.getState(newState);
          const wide = blocks ? wholeBlocks(newState, blocks) : null;
          return wide ? newState.tr.setSelection(wide) : null;
        },
        view(view) {
          const down = (event) => {
            if (event.button === 0) pressed = true;
          };
          const up = () => {
            if (!pressed) return;
            pressed = false;
            // After the editor has read where the drag ended.
            setTimeout(() => {
              if (view.isDestroyed || coarse) return;
              const blocks = key.getState(view.state);
              const wide = blocks ? wholeBlocks(view.state, blocks) : null;
              if (wide) view.dispatch(view.state.tr.setSelection(wide));
            }, 30);
          };
          view.dom.addEventListener('mousedown', down);
          document.addEventListener('mouseup', up, true);
          return {
            destroy() {
              view.dom.removeEventListener('mousedown', down);
              document.removeEventListener('mouseup', up, true);
            },
          };
        },
        props: {
          decorations(state) {
            const blocks = key.getState(state);
            if (!blocks) return null;
            return DecorationSet.create(
              state.doc,
              blocks.map(({ pos, node }) => Decoration.node(pos, pos + node.nodeSize, { class: 'is-block-selected' })),
            );
          },
          // The text highlight of the browser is hidden while blocks are marked.
          attributes: (state) => (key.getState(state) ? { class: 'has-block-selection' } : null),
        },
      }),
    ];
  },
});
