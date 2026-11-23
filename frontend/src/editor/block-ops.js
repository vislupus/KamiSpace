// The block model and the operations on blocks.
//
// As in Notion, a "block" is anything that can be grabbed, moved and turned
// into something else on its own — at any depth:
//   * a node directly inside a container: the page itself, the body of a
//     toggle, a column, a callout or a quote;
//   * a list item (bulleted, numbered, to-do), wherever its list lives.
// Lists themselves, columns and the two halves of a toggle are structure, not
// blocks. Tables are one block (their cells are plain content).
import { Fragment } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { canJoin, canSplit } from '@tiptap/pm/transform';

export const ITEM_TYPES = new Set(['listItem', 'taskItem']);
export const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);
export const CONTAINER_TYPES = new Set(['doc', 'detailsContent', 'column', 'callout', 'blockquote']);
const STRUCTURE_TYPES = new Set(['detailsSummary', 'detailsContent', 'column']);

export function isItem(node) {
  return !!node && ITEM_TYPES.has(node.type.name);
}

export function isBlockNode(node, parent) {
  if (!node || !parent || !node.isBlock) return false;
  if (isItem(node)) return true;
  if (LIST_TYPES.has(node.type.name) || STRUCTURE_TYPES.has(node.type.name)) return false;
  return CONTAINER_TYPES.has(parent.type.name);
}

/** Innermost block among the ancestors of a resolved position, or null. */
function blockAmongAncestors($pos) {
  for (let depth = $pos.depth; depth >= 1; depth -= 1) {
    if (isBlockNode($pos.node(depth), $pos.node(depth - 1))) return $pos.before(depth);
  }
  return null;
}

/** Position of the block the selection is in. */
export function currentBlockPos(state) {
  const { selection } = state;
  const { $from } = selection;
  if (selection instanceof NodeSelection && isBlockNode(selection.node, $from.parent)) {
    return $from.pos;
  }
  const found = blockAmongAncestors($from);
  if (found !== null) return found;
  // Between blocks at the top level.
  if ($from.nodeAfter) return $from.pos;
  return $from.nodeBefore ? $from.pos - $from.nodeBefore.nodeSize : 0;
}

/** Position of the block under a point of the editor, or null. */
export function blockPosAtCoords(view, left, top) {
  const found = view.posAtCoords({ left, top });
  if (!found) return null;
  const { doc } = view.state;
  if (found.inside >= 0) {
    const $inside = doc.resolve(found.inside);
    if (isBlockNode(doc.nodeAt(found.inside), $inside.parent)) return found.inside;
    const ancestor = blockAmongAncestors($inside);
    if (ancestor !== null) return ancestor;
  }
  const $pos = doc.resolve(found.pos);
  if (CONTAINER_TYPES.has($pos.parent.type.name)) {
    // Between two blocks: take the one after the gap (or the last one).
    let node = $pos.nodeAfter;
    let pos = $pos.pos;
    let forward = true;
    if (!node) {
      node = $pos.nodeBefore;
      if (!node) return blockAmongAncestors($pos);
      pos -= node.nodeSize;
      forward = false;
    }
    if (LIST_TYPES.has(node.type.name)) {
      return forward ? pos + 1 : pos + node.nodeSize - 1 - node.lastChild.nodeSize;
    }
    if (isBlockNode(node, $pos.parent)) return pos;
  }
  return blockAmongAncestors($pos);
}

/** The block that contains the block at `pos`, or null at the top level. */
export function parentBlockPos(doc, pos) {
  return blockAmongAncestors(doc.resolve(pos));
}

function itemTypeFor(schema, listType) {
  return listType.name === 'taskList' ? schema.nodes.taskItem : schema.nodes.listItem;
}

function selectInside(tr, pos) {
  const node = tr.doc.nodeAt(pos);
  if (node && (node.isAtom || node.isLeaf)) {
    return tr.setSelection(NodeSelection.create(tr.doc, pos));
  }
  const near = TextSelection.near(tr.doc.resolve(Math.min(pos + 1, tr.doc.content.size)), 1);
  return tr.setSelection(near);
}

/** Lists of the same kind that ended up next to each other become one list. */
function joinLists(tr, positions) {
  for (const pos of [...positions].sort((a, b) => b - a)) {
    if (pos <= 0 || pos >= tr.doc.content.size) continue;
    const $pos = tr.doc.resolve(pos);
    const before = $pos.nodeBefore;
    const after = $pos.nodeAfter;
    if (
      before &&
      after &&
      before.type === after.type &&
      LIST_TYPES.has(before.type.name) &&
      canJoin(tr.doc, pos)
    ) {
      tr.join(pos);
    }
  }
}

/**
 * Remove the block at `pos` from `tr.doc`. A list that loses its last item
 * goes too, and a container that may not be empty keeps an empty line.
 */
function removeBlock(tr, pos) {
  const node = tr.doc.nodeAt(pos);
  let $pos = tr.doc.resolve(pos);
  let from = pos;
  let to = pos + node.nodeSize;
  if (isItem(node) && $pos.parent.childCount === 1) {
    from = $pos.before();
    to = $pos.after();
    $pos = tr.doc.resolve(from);
  }
  const parent = $pos.parent;
  const index = $pos.index();
  if (parent.canReplace(index, index + 1)) tr.delete(from, to);
  else tr.replaceWith(from, to, tr.doc.type.schema.nodes.paragraph.create());
}

/**
 * Position of the block before (-1) or after (1) the block at `pos`, in
 * reading order: the neighbour in the same container, the first or last item
 * of a neighbouring list, or — at the edge of a list or container — the
 * block next to it. null at the ends of the document.
 */
export function adjacentBlockPos(doc, pos, direction) {
  const $pos = doc.resolve(pos);
  let depth = $pos.depth;
  let start = pos;
  for (;;) {
    const parent = $pos.node(depth);
    const index = $pos.index(depth);
    const sibling = index + direction;
    if (sibling >= 0 && sibling < parent.childCount) {
      let node = parent.child(sibling);
      let target = direction > 0 ? start + parent.child(index).nodeSize : start - node.nodeSize;
      // A list is structure: step to its first (or last) item.
      while (LIST_TYPES.has(node.type.name) && node.childCount) {
        if (direction > 0) {
          target += 1;
          node = node.firstChild;
        } else {
          target += node.nodeSize - 1 - node.lastChild.nodeSize;
          node = node.lastChild;
        }
      }
      return target;
    }
    if (depth === 0) return null;
    start = $pos.before(depth);
    depth -= 1;
  }
}

export function deleteBlock(editor, pos) {
  const { state, view } = editor;
  if (!state.doc.nodeAt(pos)) return false;
  const tr = state.tr;
  removeBlock(tr, pos);
  const at = Math.min(tr.mapping.map(pos), tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(at), -1));
  view.dispatch(tr);
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

/** Swap the block at `pos` with its previous (-1) or next (+1) sibling. */
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
  const newPos = direction < 0 ? pos - sibling.nodeSize : pos + sibling.nodeSize;
  tr.delete(pos, pos + node.nodeSize).insert(newPos, node);
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

function insideColumn($pos) {
  for (let depth = $pos.depth; depth >= 0; depth -= 1) {
    if ($pos.node(depth).type.name === 'column') return true;
  }
  return false;
}

/**
 * Move the block at `from` to the boundary `to` (a position between blocks
 * of a container, or between the items of a list). One undoable step.
 *
 * A list item dropped among ordinary blocks brings a list of its own kind;
 * an ordinary block dropped between two items splits that list around it.
 */
export function moveBlockTo(editor, from, to) {
  const { state, view } = editor;
  const { doc, schema } = state;
  const node = doc.nodeAt(from);
  if (!node) return false;
  const end = from + node.nodeSize;
  if (to >= from && to <= end) return false; // where it already is, or inside itself

  let $to = doc.resolve(to);
  let splitList = false;
  let moved = node;
  if (LIST_TYPES.has($to.parent.type.name)) {
    const list = $to.parent;
    if (isItem(node)) {
      const itemType = itemTypeFor(schema, list.type);
      if (itemType !== node.type) moved = itemType.create(null, node.content);
    } else if ($to.index() === 0) {
      $to = doc.resolve($to.before());
    } else if ($to.index() === list.childCount) {
      $to = doc.resolve($to.after());
    } else {
      splitList = true;
    }
  } else if (isItem(node)) {
    // Outside a list an item needs a list around it.
    const sourceList = doc.resolve(from).parent;
    moved = sourceList.type.create(null, node);
  }
  to = $to.pos;
  if (to >= from && to <= end) return false;

  const host = splitList ? doc.resolve($to.before()).parent : $to.parent;
  const hostIndex = splitList ? doc.resolve($to.before()).index() : $to.index();
  if (!host.canReplaceWith(hostIndex, hostIndex, moved.type)) return false;
  if (node.type.name === 'columns' && insideColumn($to)) return false;

  const tr = state.tr;
  removeBlock(tr, from);
  let at = tr.mapping.map(to);
  if (splitList) {
    if (!canSplit(tr.doc, at, 1)) return false;
    tr.split(at, 1);
    at += 1;
  }
  tr.insert(at, moved);
  const stepsBefore = tr.steps.length;
  joinLists(tr, [at, at + moved.nodeSize]);
  const anchor = tr.mapping.slice(stepsBefore).map(at);
  const target = tr.doc.nodeAt(anchor);
  if (target && target === moved && (moved.isAtom || moved.isLeaf)) {
    tr.setSelection(NodeSelection.create(tr.doc, anchor));
  } else {
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(anchor + 1, tr.doc.content.size)), 1));
  }
  view.dispatch(tr);
  view.focus();
  return true;
}

// -- turning a block into another kind ----------------------------------------

/**
 * What kind of block a node is, in the vocabulary of the block catalogue:
 * { kind: 'text' | 'heading' | 'code' | 'bullet' | 'numbered' | 'todo' |
 *         'toggle' | 'quote' | 'callout', level? } — or null for blocks that
 * cannot be converted (images, tables, embeds…).
 */
export function blockKind(node, parent) {
  switch (node.type.name) {
    case 'paragraph':
      return { kind: 'text' };
    case 'heading':
      return { kind: 'heading', level: node.attrs.level };
    case 'codeBlock':
      return { kind: 'code' };
    case 'listItem':
      return { kind: parent?.type.name === 'orderedList' ? 'numbered' : 'bullet' };
    case 'taskItem':
      return { kind: 'todo' };
    case 'details':
      return { kind: 'toggle', level: node.attrs.level || 0 };
    case 'blockquote':
      return { kind: 'quote' };
    case 'callout':
      return { kind: 'callout' };
    default:
      return null;
  }
}

export function sameKind(a, b) {
  return !!a && !!b && a.kind === b.kind && (a.level ?? 0) === (b.level ?? 0);
}

/** The block's own line of text, and the blocks nested under it. */
function decompose(node, schema) {
  const name = node.type.name;
  if (node.isTextblock) {
    const inline =
      name === 'codeBlock'
        ? node.textContent
          ? Fragment.from(schema.text(node.textContent))
          : Fragment.empty
        : node.content;
    return { inline, children: [] };
  }
  const children = [];
  if (name === 'details') {
    node.child(1).forEach((child) => children.push(child));
    const onlyBlank =
      children.length === 1 && children[0].type.name === 'paragraph' && !children[0].content.size;
    return { inline: node.child(0).content, children: onlyBlank ? [] : children };
  }
  if (isItem(node) || name === 'blockquote' || name === 'callout') {
    node.forEach((child) => children.push(child));
    const first = children[0];
    if (first && first.type.name === 'paragraph') {
      return { inline: first.content, children: children.slice(1) };
    }
    return { inline: Fragment.empty, children };
  }
  return null;
}

function compose(schema, target, { inline, children }) {
  const { nodes } = schema;
  const paragraph = () => nodes.paragraph.create(null, inline);
  switch (target.kind) {
    case 'text':
      return [paragraph(), ...children];
    case 'heading':
      return [nodes.heading.create({ level: target.level }, inline), ...children];
    case 'code': {
      const text = inline.textBetween(0, inline.size, '\n', ' ');
      return [nodes.codeBlock.create(null, text ? schema.text(text) : null), ...children];
    }
    case 'bullet':
    case 'numbered':
    case 'todo': {
      const listType = { bullet: nodes.bulletList, numbered: nodes.orderedList, todo: nodes.taskList }[
        target.kind
      ];
      const item = itemTypeFor(schema, listType).create(null, [paragraph(), ...children]);
      return [listType.create(null, item)];
    }
    case 'toggle':
      return [
        nodes.details.create({ open: true, level: target.level ?? 0 }, [
          nodes.detailsSummary.create(null, inline),
          nodes.detailsContent.create(null, children),
        ]),
      ];
    case 'quote':
      return [nodes.blockquote.create(null, [paragraph(), ...children])];
    case 'callout':
      return [nodes.callout.create(null, [paragraph(), ...children])];
    default:
      return null;
  }
}

/**
 * Turn the block at `pos` into another kind, in place: its text stays its
 * text and nested blocks stay nested (or follow it, where the new kind cannot
 * hold them). Works at any depth without disturbing the surrounding blocks.
 *
 * This variant adds its steps to an existing transaction (so it can be part
 * of a larger change, such as an input rule). Returns false when the block,
 * or the place it is in, does not allow the conversion.
 */
export function convertBlockInTransaction(tr, pos, target) {
  const { doc } = tr;
  const { schema } = doc.type;
  const node = doc.nodeAt(pos);
  if (!node) return false;
  const $pos = doc.resolve(pos);
  const current = blockKind(node, $pos.parent);
  if (!current) return false;
  if (sameKind(current, target)) return true;

  let start = pos;
  let composed;
  if (current.kind === 'toggle' && target.kind === 'toggle') {
    // Only the heading level changes; open state and content stay.
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, level: target.level ?? 0 });
    composed = [tr.doc.nodeAt(pos)];
  } else {
    const parts = decompose(node, schema);
    if (!parts) return false;
    composed = compose(schema, target, parts);
    if (!composed) return false;

    if (isItem(node)) {
      // Take the item out of its list: [items before] new block(s) [items after].
      const list = $pos.parent;
      const listPos = $pos.before();
      const $list = doc.resolve(listPos);
      const index = $pos.index();
      const offset = pos - listPos - 1;
      const before = index > 0 ? list.cut(0, offset) : null;
      let after = index < list.childCount - 1 ? list.cut(offset + node.nodeSize) : null;
      if (after && list.type.name === 'orderedList') {
        const first = (list.attrs.start ?? 1) + index + 1;
        after = after.type.create({ ...after.attrs, start: first }, after.content);
      }
      const fragment = Fragment.from([before, ...composed, after].filter(Boolean));
      if (!$list.parent.canReplace($list.index(), $list.index() + 1, fragment)) return false;
      tr.replaceWith(listPos, listPos + list.nodeSize, fragment);
      start = listPos + (before ? before.nodeSize : 0);
    } else {
      const fragment = Fragment.from(composed);
      if (!$pos.parent.canReplace($pos.index(), $pos.index() + 1, fragment)) return false;
      tr.replaceWith(pos, pos + node.nodeSize, fragment);
    }
  }

  const size = composed.reduce((total, part) => total + part.nodeSize, 0);
  const stepsBefore = tr.steps.length;
  joinLists(tr, [start, start + size]);
  const anchor = tr.mapping.slice(stepsBefore).map(start);
  // Caret at the end of the block's own text.
  const near = TextSelection.near(tr.doc.resolve(Math.min(anchor + 1, tr.doc.content.size)), 1);
  tr.setSelection(TextSelection.create(tr.doc, near.$head.end()));
  return true;
}

/** Convert the block at `pos` and apply the change to the editor. */
export function convertBlock(editor, pos, target) {
  const { state, view } = editor;
  const tr = state.tr;
  if (!convertBlockInTransaction(tr, pos, target)) return false;
  if (tr.docChanged) view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/**
 * Alt+Shift+↑/↓: move the current block one step. Among siblings it swaps
 * places; at the edge of a list, toggle, column… it steps out of it.
 */
export function moveBlockByKeyboard(editor, direction) {
  const { state } = editor;
  const { doc } = state;
  const pos = currentBlockPos(state);
  const node = doc.nodeAt(pos);
  if (!node) return false;
  if (moveNode(editor, pos, direction)) return true;

  const $pos = doc.resolve(pos);
  if (isItem(node)) {
    // Step over the block next to the list.
    const listPos = $pos.before();
    const $list = doc.resolve(listPos);
    const index = $list.index();
    const outer = $list.parent;
    if (direction < 0 && index > 0) {
      if (moveBlockTo(editor, pos, listPos - outer.child(index - 1).nodeSize)) return true;
    } else if (direction > 0 && index < outer.childCount - 1) {
      const listEnd = listPos + $pos.parent.nodeSize;
      if (moveBlockTo(editor, pos, listEnd + outer.child(index + 1).nodeSize)) return true;
    }
  }
  // Otherwise leave the surrounding block (toggle, callout, parent item…).
  const parentPos = parentBlockPos(doc, pos);
  if (parentPos === null) return false;
  const parent = doc.nodeAt(parentPos);
  return moveBlockTo(editor, pos, direction < 0 ? parentPos : parentPos + parent.nodeSize);
}

/** Tab: put the current block inside the toggle right above it. */
export function indentIntoToggle(editor) {
  const { state } = editor;
  const pos = currentBlockPos(state);
  const node = state.doc.nodeAt(pos);
  if (!node || isItem(node)) return false;
  const $pos = state.doc.resolve(pos);
  const previous = $pos.nodeBefore;
  if (!previous || previous.type.name !== 'details') return false;
  const togglePos = pos - previous.nodeSize;
  const offsetInBlock = state.selection.from - pos;
  if (!moveBlockTo(editor, pos, pos - 2)) return false; // the end of the toggle's body
  // Open the toggle so the block stays visible, and keep the caret in place.
  const { view } = editor;
  const toggle = view.state.doc.nodeAt(togglePos);
  const tr = view.state.tr;
  if (toggle && !toggle.attrs.open) {
    tr.setNodeMarkup(togglePos, undefined, { ...toggle.attrs, open: true });
  }
  const moved = pos - 2;
  if (offsetInBlock > 0 && offsetInBlock < node.nodeSize) {
    tr.setSelection(TextSelection.near(tr.doc.resolve(moved + offsetInBlock)));
  }
  view.dispatch(tr);
  return true;
}

/** Shift+Tab: take the current block out of the toggle it is in. */
export function outdentFromToggle(editor) {
  const { state } = editor;
  const pos = currentBlockPos(state);
  const node = state.doc.nodeAt(pos);
  if (!node || isItem(node)) return false;
  const $pos = state.doc.resolve(pos);
  if ($pos.parent.type.name !== 'detailsContent') return false;
  const togglePos = $pos.before($pos.depth - 1);
  const toggle = state.doc.nodeAt(togglePos);
  const offsetInBlock = state.selection.from - pos;
  if (!moveBlockTo(editor, pos, togglePos + toggle.nodeSize)) return false;
  const { view } = editor;
  const moved = togglePos + toggle.nodeSize - node.nodeSize;
  if (offsetInBlock > 0 && offsetInBlock < node.nodeSize) {
    view.dispatch(
      view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(moved + offsetInBlock))),
    );
  }
  return true;
}
