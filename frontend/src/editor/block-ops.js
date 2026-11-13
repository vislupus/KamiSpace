// Operations on whole blocks, addressed by document position.
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { findWrapping } from '@tiptap/pm/transform';

const ITEM_TYPES = new Set(['listItem', 'taskItem']);

function selectInside(tr, pos) {
  const node = tr.doc.nodeAt(pos);
  if (!node) return tr;
  if (node.isAtom || node.isLeaf) return tr.setSelection(NodeSelection.create(tr.doc, pos));
  return tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1), 1));
}

export function deleteBlock(editor, pos) {
  const { state, view } = editor;
  const node = state.doc.nodeAt(pos);
  if (!node) return false;
  const tr = state.tr.delete(pos, pos + node.nodeSize);
  // Never leave the document empty.
  if (tr.doc.childCount === 0) tr.insert(0, state.schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size)), -1));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

export function duplicateBlock(editor, pos) {
  const { state, view } = editor;
  const node = state.doc.nodeAt(pos);
  if (!node) return false;
  const insertAt = pos + node.nodeSize;
  const tr = state.tr.insert(insertAt, node.type.create(node.attrs, node.content, node.marks));
  view.dispatch(selectInside(tr, insertAt).scrollIntoView());
  view.focus();
  return true;
}

/**
 * Swap the node at `pos` with its previous (-1) or next (+1) sibling.
 * Works for top-level blocks and for list items alike.
 */
export function moveNode(editor, pos, direction) {
  const { state, view } = editor;
  const $pos = state.doc.resolve(pos);
  const parent = $pos.parent;
  const index = $pos.index();
  const node = parent.maybeChild(index);
  const targetIndex = index + direction;
  if (!node || targetIndex < 0 || targetIndex >= parent.childCount) return false;

  const sibling = parent.child(targetIndex);
  const selection = state.selection;
  const offsetInNode = selection.from - pos;
  const tr = state.tr;
  let newPos;
  if (direction < 0) {
    newPos = pos - sibling.nodeSize;
    tr.delete(pos, pos + node.nodeSize).insert(newPos, node);
  } else {
    newPos = pos + sibling.nodeSize;
    tr.delete(pos, pos + node.nodeSize).insert(newPos, node);
  }
  // Keep the caret where it was inside the moved block.
  const inside = offsetInNode > 0 && offsetInNode < node.nodeSize;
  if (selection instanceof NodeSelection && selection.from === pos) {
    tr.setSelection(NodeSelection.create(tr.doc, newPos));
  } else if (inside) {
    tr.setSelection(TextSelection.near(tr.doc.resolve(newPos + offsetInNode)));
  } else {
    selectInside(tr, newPos);
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Position of the block the selection is in: a list item if any, else the top-level block. */
export function currentBlockPos(state, { preferListItem = true } = {}) {
  const { $from } = state.selection;
  if (state.selection instanceof NodeSelection && $from.depth === 0) return $from.pos;
  if (preferListItem) {
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if (ITEM_TYPES.has($from.node(depth).type.name)) return $from.before(depth);
    }
  }
  return $from.depth === 0 ? $from.pos : $from.before(1);
}

export function topLevelBlockPos(state) {
  return currentBlockPos(state, { preferListItem: false });
}

/**
 * Move the top-level block at `from` so that it starts at `to` (a position
 * between top-level blocks, in the current document). One undoable step.
 */
export function moveBlockTo(editor, from, to) {
  const { state, view } = editor;
  const node = state.doc.nodeAt(from);
  if (!node) return false;
  const end = from + node.nodeSize;
  if (to >= from && to <= end) return false; // dropped where it already is
  const tr = state.tr.delete(from, end);
  const target = tr.mapping.map(to);
  tr.insert(target, node);
  selectInside(tr, target);
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/**
 * Tiptap command: wrap the selection in a container block (quote, callout).
 * Inside a list the innermost block cannot be wrapped on its own, so the
 * whole top-level block is wrapped instead.
 */
export function wrapSelectionIn(typeName, attrs = null) {
  return ({ state, dispatch }) => {
    const type = state.schema.nodes[typeName];
    const { $from, $to } = state.selection;
    let range = $from.blockRange($to);
    let wrapping = range && findWrapping(range, type, attrs);
    if (!wrapping && $from.depth > 0) {
      const $start = state.doc.resolve($from.before(1));
      const $end = state.doc.resolve($to.after(1));
      range = $start.blockRange($end);
      wrapping = range && findWrapping(range, type, attrs);
    }
    if (!wrapping) return false;
    if (dispatch) dispatch(state.tr.wrap(range, wrapping).scrollIntoView());
    return true;
  };
}
