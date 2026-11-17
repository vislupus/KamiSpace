// The "+" button and drag handle that appear next to the block under the
// pointer — for every block, at any depth: lines inside a toggle, blocks in a
// column, single list items. Dragging a handle moves the block; a line shows
// where it will land, including inside a toggle or a column. A move is one
// undoable step.
import { Extension } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import { h, kbd } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { openMenu } from '../../lib/menu.js';
import { clamp } from '../../lib/util.js';
import {
  ITEM_TYPES,
  blockKind,
  blockPosAtCoords,
  deleteBlock,
  duplicateBlock,
  isItem,
  moveBlockTo,
  moveNode,
  parentBlockPos,
  sameKind,
} from '../block-ops.js';
import { CONVERTIBLE_BLOCKS, applyBlockAt } from '../blocks.js';

const HANDLE_HEIGHT = 24;
const HANDLE_WIDTH = 46;
const CENTERED_TYPES = new Set(['horizontalRule']);
const TOP_ALIGNED_TYPES = new Set([
  'image',
  'attachment',
  'table',
  'codeBlock',
  'columns',
  'embed',
  'bookmark',
  'video',
  'audio',
  'blockEquation',
]);

/** The element that holds a block's own first line (for vertical alignment). */
function firstLineElement(node, dom) {
  if (node.type.name === 'details') return dom.querySelector('summary') ?? dom;
  if (ITEM_TYPES.has(node.type.name)) {
    return dom.querySelector(':scope > p, :scope > div > p') ?? dom;
  }
  return dom;
}

class BlockHandleView {
  constructor(view, editor) {
    this.view = view;
    this.editor = editor;
    this.blockPos = null;
    this.menuOpen = false;
    this.frame = 0;
    this.pointer = null;
    this.dragFrom = null;
    this.container = view.dom.parentElement;
    this.controller = new AbortController();
    const { signal } = this.controller;

    this.addButton = h(
      'button',
      {
        class: 'block-button block-add',
        type: 'button',
        title: 'Click to add below\nAlt-click to add above',
        'aria-label': 'Add block',
      },
      icon('plus', 16),
    );
    this.grip = h(
      'button',
      {
        class: 'block-button block-grip',
        type: 'button',
        draggable: true,
        title: 'Drag to move\nClick to open menu',
        'aria-label': 'Block options',
        'aria-haspopup': 'menu',
      },
      icon('grip', 16),
    );
    this.el = h('div', { class: 'block-handle', contentEditable: 'false' }, this.addButton, this.grip);
    this.el.hidden = true;
    this.dropLine = h('div', { class: 'block-drop-line', hidden: true });
    this.container.append(this.el, this.dropLine);

    this.container.addEventListener('mousemove', (event) => this.onPointerMove(event), { signal });
    this.container.addEventListener('mouseleave', () => this.scheduleHide(), { signal });
    view.dom.addEventListener('keydown', () => this.hide(), { signal });
    this.el.addEventListener('mouseenter', () => clearTimeout(this.hideTimer), { signal });

    this.addButton.addEventListener('mousedown', (event) => event.preventDefault(), { signal });
    this.addButton.addEventListener('click', (event) => this.onAdd(event), { signal });
    this.grip.addEventListener('click', () => this.openBlockMenu(), { signal });
    this.grip.addEventListener('dragstart', (event) => this.onDragStart(event), { signal });
    this.grip.addEventListener('dragend', () => this.onDragEnd(), { signal });
    view.dom.addEventListener('dragover', (event) => this.onDragOver(event), { signal });
  }

  // -- locating the block under the pointer --------------------------------

  /** Horizontal limits of the text column (the editor minus its gutters). */
  contentBounds() {
    const rect = this.view.dom.getBoundingClientRect();
    const style = getComputedStyle(this.view.dom);
    return {
      left: rect.left + (parseFloat(style.paddingLeft) || 0),
      right: rect.right - (parseFloat(style.paddingRight) || 0),
      top: rect.top,
      bottom: rect.bottom,
    };
  }

  blockAt(clientX, clientY) {
    const bounds = this.contentBounds();
    if (clientY < bounds.top || clientY > bounds.bottom) return null;
    // In the gutter the pointer still counts as being on the block beside it.
    const x = clamp(clientX, bounds.left + 4, bounds.right - 4);
    return blockPosAtCoords(this.view, x, clientY);
  }

  /** While the pointer travels from a block to its handle, keep that block. */
  pointerInHandleZone(clientX, clientY) {
    if (this.blockPos === null || this.el.hidden) return false;
    const handle = this.el.getBoundingClientRect();
    const dom = this.view.nodeDOM(this.blockPos);
    if (!(dom instanceof HTMLElement)) return false;
    const block = dom.getBoundingClientRect();
    return (
      clientX >= handle.left - 6 &&
      clientX <= block.left + 2 &&
      clientY >= Math.min(handle.top, block.top) - 2 &&
      clientY <= handle.bottom + 6
    );
  }

  onPointerMove(event) {
    if (!this.editor.isEditable || this.menuOpen || event.buttons) return;
    this.pointer = { x: event.clientX, y: event.clientY };
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.view.isDestroyed) return;
      const { x, y } = this.pointer;
      if (this.pointerInHandleZone(x, y)) return;
      const pos = this.blockAt(x, y);
      if (pos !== null) this.show(pos);
    });
  }

  show(pos) {
    const node = this.view.state.doc.nodeAt(pos);
    const dom = this.view.nodeDOM(pos);
    if (!node || !(dom instanceof HTMLElement)) {
      this.hide();
      return;
    }
    clearTimeout(this.hideTimer);
    this.blockPos = pos;
    const rect = dom.getBoundingClientRect();
    const containerRect = this.container.getBoundingClientRect();
    let top = rect.top - containerRect.top;
    if (CENTERED_TYPES.has(node.type.name)) {
      top += rect.height / 2 - HANDLE_HEIGHT / 2;
    } else if (TOP_ALIGNED_TYPES.has(node.type.name)) {
      top += 4;
    } else {
      const line = firstLineElement(node, dom);
      const style = getComputedStyle(line);
      const lineHeight = parseFloat(style.lineHeight) || 24;
      top =
        line.getBoundingClientRect().top -
        containerRect.top +
        (line === dom ? parseFloat(style.paddingTop) || 0 : 0) +
        (lineHeight - HANDLE_HEIGHT) / 2;
    }
    // Bullets and numbers sit to the left of a list item's box.
    const marker = node.type.name === 'listItem' ? 24 : 0;
    const left = rect.left - containerRect.left - marker - HANDLE_WIDTH;
    this.el.style.top = `${Math.round(top)}px`;
    this.el.style.left = `${Math.round(Math.max(left, 0))}px`;
    this.el.hidden = false;
  }

  scheduleHide() {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (!this.menuOpen) this.hide();
    }, 180);
  }

  hide() {
    if (this.menuOpen) return;
    this.el.hidden = true;
    this.blockPos = null;
  }

  currentNode() {
    return this.blockPos === null ? null : this.view.state.doc.nodeAt(this.blockPos);
  }

  // -- "+" button -----------------------------------------------------------

  onAdd(event) {
    const node = this.currentNode();
    if (!node) return;
    const pos = this.blockPos;
    const chain = this.editor.chain();
    if (node.type.name === 'paragraph' && node.content.size === 0) {
      chain.setTextSelection(pos + 1);
    } else {
      const insertAt = event.altKey ? pos : pos + node.nodeSize;
      // Next to a list item the new line is a list item too.
      const fresh = isItem(node)
        ? { type: node.type.name, content: [{ type: 'paragraph' }] }
        : { type: 'paragraph' };
      chain.insertContentAt(insertAt, fresh).setTextSelection(insertAt + (isItem(node) ? 2 : 1));
    }
    // Typing "/" opens the block menu, exactly as if the user had typed it.
    chain.focus().insertContent('/').run();
    this.hide();
  }

  // -- drag and drop --------------------------------------------------------

  onDragStart(event) {
    const node = this.currentNode();
    if (!node) {
      event.preventDefault();
      return;
    }
    const { view } = this;
    this.dragFrom = this.blockPos;
    try {
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, this.blockPos)));
    } catch {
      // Not every block can be selected as a node; the drag works regardless.
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', node.textContent || ' ');
    const dom = view.nodeDOM(this.blockPos);
    if (dom instanceof HTMLElement) event.dataTransfer.setDragImage(dom, 0, 0);
    document.documentElement.classList.add('is-block-dragging');
    // Hiding the drag source synchronously would cancel the drag.
    setTimeout(() => {
      this.el.hidden = true;
    }, 0);
  }

  /**
   * Where a drop at this point would put the block: a boundary position in
   * the document plus the geometry of the indicator line.
   */
  dropTarget(clientX, clientY) {
    const { view } = this;
    const { doc } = view.state;
    const containerRect = this.container.getBoundingClientRect();
    const line = (rect, y, indent = 0) => ({
      top: y - containerRect.top,
      left: rect.left - containerRect.left + indent,
      width: Math.max(rect.width - indent, 40),
    });

    let pos = this.blockAt(clientX, clientY);
    if (pos === null) return null;
    const source = doc.nodeAt(this.dragFrom);
    // Never into the block that is being dragged.
    if (source && pos >= this.dragFrom && pos < this.dragFrom + source.nodeSize) return null;

    let node = doc.nodeAt(pos);
    let dom = view.nodeDOM(pos);
    if (!node || !(dom instanceof HTMLElement)) return null;
    let rect = dom.getBoundingClientRect();
    const row = firstLineElement(node, dom).getBoundingClientRect();
    const upperHalf = clientY < (node.type.name === 'details' || isItem(node) ? row.top + row.height / 2 : rect.top + rect.height / 2);

    if (node.type.name === 'details') {
      const summarySize = node.firstChild.nodeSize;
      if (clientY <= row.bottom + 2) {
        if (upperHalf) return { to: pos, ...line(rect, rect.top - 2) };
        // Lower half of the summary: into the toggle when it is open, or when
        // the pointer is clearly indented.
        if (node.attrs.open || clientX > rect.left + 40) {
          return { to: pos + 1 + summarySize + 1, ...line(rect, row.bottom + 1, 26) };
        }
        return { to: pos + node.nodeSize, ...line(rect, rect.bottom + 2) };
      }
      // Below the summary but not on a child: the end of the toggle's body.
      return { to: pos + node.nodeSize - 2, ...line(rect, rect.bottom, 26) };
    }

    if (upperHalf) {
      const marker = node.type.name === 'listItem' ? 24 : 0;
      return { to: pos, ...line(rect, rect.top - 2, -marker) };
    }
    // After the block. With the pointer left of a nested block that is the
    // last of its kind, the drop goes after the block that contains it.
    for (;;) {
      const $pos = doc.resolve(pos);
      const isLast = $pos.index() === $pos.parent.childCount - 1;
      const outer = isLast ? parentBlockPos(doc, pos) : null;
      const marker = node.type.name === 'listItem' ? 24 : 0;
      if (outer === null || clientX >= rect.left - marker - 8) break;
      const outerDom = view.nodeDOM(outer);
      if (!(outerDom instanceof HTMLElement)) break;
      pos = outer;
      node = doc.nodeAt(pos);
      dom = outerDom;
      rect = dom.getBoundingClientRect();
    }
    const marker = node.type.name === 'listItem' ? 24 : 0;
    return { to: pos + node.nodeSize, ...line(rect, rect.bottom + 2, -marker) };
  }

  onDragOver(event) {
    if (this.dragFrom === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const target = this.dropTarget(event.clientX, event.clientY);
    if (!target) {
      this.dropLine.hidden = true;
      return;
    }
    this.dropLine.style.top = `${Math.round(target.top)}px`;
    this.dropLine.style.left = `${Math.round(target.left)}px`;
    this.dropLine.style.width = `${Math.round(target.width)}px`;
    this.dropLine.hidden = false;
  }

  /** Called through the plugin's handleDrop; true when the drop was ours. */
  onDrop(event) {
    if (this.dragFrom === null) return false;
    const target = this.dropTarget(event.clientX, event.clientY);
    const from = this.dragFrom;
    this.finishDrag();
    if (target) moveBlockTo(this.editor, from, target.to);
    return true;
  }

  finishDrag() {
    this.dragFrom = null;
    this.dropLine.hidden = true;
    document.documentElement.classList.remove('is-block-dragging');
  }

  onDragEnd() {
    this.finishDrag();
    this.blockPos = null;
  }

  // -- block menu -----------------------------------------------------------

  openBlockMenu() {
    const node = this.currentNode();
    if (!node || this.menuOpen) return;
    const { editor } = this;
    const pos = this.blockPos;
    const $pos = this.view.state.doc.resolve(pos);
    const index = $pos.index();
    const count = $pos.parent.childCount;
    const kind = blockKind(node, $pos.parent);

    const turnInto = kind
      ? {
          label: 'Turn into',
          icon: 'refresh',
          submenu: CONVERTIBLE_BLOCKS.map((block) => ({
            label: block.title,
            icon: block.icon,
            checked: sameKind(kind, block.kind),
            onSelect: () => applyBlockAt(editor, pos, block),
          })),
        }
      : null;

    // Blocks inside a column layout (and the layout itself) can change it.
    let layout = node.type.name === 'columns' ? { node, pos } : null;
    for (let depth = $pos.depth; depth > 0 && !layout; depth -= 1) {
      if ($pos.node(depth).type.name === 'columns') {
        layout = { node: $pos.node(depth), pos: $pos.before(depth) };
      }
    }
    const inColumns = (command) => () => {
      editor.chain().setTextSelection(layout.pos + 3).run();
      editor.chain().focus()[command]().run();
    };
    const columnItems = layout
      ? [
          { separator: true },
          {
            label: 'Add a column',
            icon: 'column-add',
            disabled: layout.node.childCount >= 5,
            onSelect: inColumns('addColumn'),
          },
          { label: 'Remove columns (keep content)', icon: 'rows', onSelect: inColumns('unsetColumns') },
        ]
      : [];

    this.menuOpen = true;
    this.grip.setAttribute('aria-expanded', 'true');
    openMenu({
      anchor: this.grip,
      placement: 'bottom-start',
      items: [
        turnInto,
        {
          label: 'Duplicate',
          icon: 'copy',
          hint: kbd('Mod+D'),
          onSelect: () => duplicateBlock(editor, pos),
        },
        {
          label: 'Move up',
          icon: 'arrow-up',
          hint: kbd('Alt+Shift+↑'),
          disabled: index === 0,
          onSelect: () => moveNode(editor, pos, -1),
        },
        {
          label: 'Move down',
          icon: 'arrow-down',
          hint: kbd('Alt+Shift+↓'),
          disabled: index >= count - 1,
          onSelect: () => moveNode(editor, pos, 1),
        },
        ...columnItems,
        { separator: true },
        {
          label: 'Delete',
          icon: 'trash-2',
          danger: true,
          onSelect: () => deleteBlock(editor, pos),
        },
      ],
      onClose: () => {
        this.menuOpen = false;
        this.grip.removeAttribute('aria-expanded');
        this.hide();
      },
    });
  }

  // -- plugin view lifecycle ------------------------------------------------

  update(view, previous) {
    this.view = view;
    // Content moved: the stored position may point somewhere else now.
    if (previous && !previous.doc.eq(view.state.doc) && !this.menuOpen) this.hide();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    clearTimeout(this.hideTimer);
    this.finishDrag();
    this.controller.abort();
    this.el.remove();
    this.dropLine.remove();
  }
}

export const BlockHandle = Extension.create({
  name: 'blockHandle',

  addProseMirrorPlugins() {
    const editor = this.editor;
    let handle = null;
    return [
      new Plugin({
        key: new PluginKey('blockHandle'),
        view: (view) => {
          handle = new BlockHandleView(view, editor);
          return handle;
        },
        props: {
          handleDrop: (_view, event) => handle?.onDrop(event) ?? false,
        },
      }),
    ];
  },
});
