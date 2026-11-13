// The "+" button and drag handle that appear next to the block under the
// pointer. Dragging uses ProseMirror's own drag-and-drop: we select the block
// and hand the editor a slice to move, so drops, the drop cursor and undo all
// behave exactly like native editor drags.
import { Extension } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import { h, kbd } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { openMenu } from '../../lib/menu.js';
import { deleteBlock, duplicateBlock, moveNode } from '../block-ops.js';
import { CONVERTIBLE_BLOCKS, applyBlock } from '../blocks.js';

const HANDLE_HEIGHT = 24;
const CENTERED_TYPES = new Set(['horizontalRule']);
const TOP_ALIGNED_TYPES = new Set(['image', 'attachment', 'table', 'codeBlock']);
const NOT_CONVERTIBLE = new Set(['image', 'attachment', 'table', 'horizontalRule']);

class BlockHandleView {
  constructor(view, editor) {
    this.view = view;
    this.editor = editor;
    this.blockPos = null;
    this.menuOpen = false;
    this.frame = 0;
    this.pointer = null;
    this.container = view.dom.parentElement;
    this.controller = new AbortController();
    const { signal } = this.controller;

    this.addButton = h(
      'button',
      {
        class: 'block-button block-add',
        type: 'button',
        title: 'Add a block below (Alt+click: above)',
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
        title: 'Drag to move · Click for options',
        'aria-label': 'Block options',
        'aria-haspopup': 'menu',
      },
      icon('grip', 16),
    );
    this.el = h('div', { class: 'block-handle', contentEditable: 'false' }, this.addButton, this.grip);
    this.el.hidden = true;
    this.container.append(this.el);

    this.container.addEventListener('mousemove', (event) => this.onPointerMove(event), { signal });
    this.container.addEventListener('mouseleave', () => this.scheduleHide(), { signal });
    view.dom.addEventListener('keydown', () => this.hide(), { signal });
    this.el.addEventListener('mouseenter', () => clearTimeout(this.hideTimer), { signal });

    this.addButton.addEventListener('mousedown', (event) => event.preventDefault(), { signal });
    this.addButton.addEventListener('click', (event) => this.onAdd(event), { signal });
    this.grip.addEventListener('click', () => this.openBlockMenu(), { signal });
    this.grip.addEventListener('dragstart', (event) => this.onDragStart(event), { signal });
    this.grip.addEventListener('dragend', () => this.onDragEnd(), { signal });
  }

  // -- locating the block under the pointer --------------------------------

  blockAt(clientY) {
    const { view } = this;
    const rect = view.dom.getBoundingClientRect();
    if (clientY < rect.top || clientY > rect.bottom) return null;
    const paddingLeft = parseFloat(getComputedStyle(view.dom).paddingLeft) || 0;
    // Probe inside the text column so the gutter counts as "on the block".
    const found = view.posAtCoords({ left: rect.left + paddingLeft + 12, top: clientY });
    if (!found) return null;
    const doc = view.state.doc;
    const $pos = doc.resolve(found.inside >= 0 ? found.inside : found.pos);
    if ($pos.depth > 0) return $pos.before(1);
    if ($pos.nodeAfter) return $pos.pos;
    if ($pos.nodeBefore) return $pos.pos - $pos.nodeBefore.nodeSize;
    return null;
  }

  onPointerMove(event) {
    if (!this.editor.isEditable || this.menuOpen || event.buttons) return;
    this.pointer = event.clientY;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.view.isDestroyed) return;
      const pos = this.blockAt(this.pointer);
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
    const style = getComputedStyle(dom);
    let top = rect.top - containerRect.top;
    if (CENTERED_TYPES.has(node.type.name)) {
      top += rect.height / 2 - HANDLE_HEIGHT / 2;
    } else if (TOP_ALIGNED_TYPES.has(node.type.name)) {
      top += 6;
    } else {
      const lineHeight = parseFloat(style.lineHeight) || 24;
      top += (parseFloat(style.paddingTop) || 0) + (lineHeight - HANDLE_HEIGHT) / 2;
    }
    this.el.style.top = `${Math.round(top)}px`;
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
      chain.insertContentAt(insertAt, { type: 'paragraph' }).setTextSelection(insertAt + 1);
    }
    // Typing "/" opens the block menu, exactly as if the user had typed it.
    chain.focus().insertContent('/').run();
    this.hide();
  }

  // -- drag and drop --------------------------------------------------------

  selectBlock() {
    if (this.currentNode() === null) return;
    const { state } = this.view;
    this.view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, this.blockPos)));
  }

  onDragStart(event) {
    const node = this.currentNode();
    if (!node) {
      event.preventDefault();
      return;
    }
    const { view } = this;
    this.selectBlock();
    const selection = view.state.selection;
    view.dragging = { slice: selection.content(), move: true };
    event.dataTransfer.effectAllowed = 'copyMove';
    event.dataTransfer.setData('text/plain', node.textContent || ' ');
    const dom = view.nodeDOM(this.blockPos);
    if (dom instanceof HTMLElement) event.dataTransfer.setDragImage(dom, 0, 0);
    view.dom.classList.add('is-block-dragging');
    this.el.hidden = true;
  }

  onDragEnd() {
    const { view } = this;
    view.dom.classList.remove('is-block-dragging');
    // Mirrors ProseMirror's own dragend handling.
    setTimeout(() => {
      if (!view.isDestroyed) view.dragging = null;
    }, 50);
    this.blockPos = null;
  }

  // -- block menu -----------------------------------------------------------

  openBlockMenu() {
    const node = this.currentNode();
    if (!node || this.menuOpen) return;
    const { editor } = this;
    const pos = this.blockPos;
    const index = this.view.state.doc.resolve(pos).index();
    const count = this.view.state.doc.childCount;

    const turnInto = NOT_CONVERTIBLE.has(node.type.name)
      ? null
      : {
          label: 'Turn into',
          icon: 'refresh',
          submenu: CONVERTIBLE_BLOCKS.map((block) => ({
            label: block.title,
            icon: block.icon,
            onSelect: () => {
              // Put the caret inside the block, then convert it.
              if (!node.isAtom) editor.commands.setTextSelection(pos + 1);
              applyBlock(editor, block);
            },
          })),
        };

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
    this.controller.abort();
    this.el.remove();
  }
}

export const BlockHandle = Extension.create({
  name: 'blockHandle',

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('blockHandle'),
        view: (view) => new BlockHandleView(view, editor),
      }),
    ];
  },
});
