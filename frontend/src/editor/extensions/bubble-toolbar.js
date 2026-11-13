// Floating formatting toolbar, shown only while text is selected.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { h, kbd } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { openMenu } from '../../lib/menu.js';
import { positionElement } from '../../lib/popover.js';
import { CONVERTIBLE_BLOCKS, applyBlock, currentBlockLabel } from '../blocks.js';
import { openLinkEditor } from './link-editor.js';

const MARKS = [
  { name: 'bold', icon: 'bold', title: `Bold (${kbd('Mod+B')})`, run: (c) => c.toggleBold() },
  { name: 'italic', icon: 'italic', title: `Italic (${kbd('Mod+I')})`, run: (c) => c.toggleItalic() },
  {
    name: 'underline',
    icon: 'underline',
    title: `Underline (${kbd('Mod+U')})`,
    run: (c) => c.toggleUnderline(),
  },
  {
    name: 'strike',
    icon: 'strike',
    title: `Strikethrough (${kbd('Mod+Shift+S')})`,
    run: (c) => c.toggleStrike(),
  },
  { name: 'code', icon: 'code', title: `Inline code (${kbd('Mod+E')})`, run: (c) => c.toggleCode() },
];

class BubbleToolbarView {
  constructor(view, editor) {
    this.view = view;
    this.editor = editor;
    this.pointerDown = false;
    this.menu = null;
    this.controller = new AbortController();
    const { signal } = this.controller;

    this.turnInto = h(
      'button',
      { class: 'bubble-button bubble-turn', type: 'button', title: 'Turn into' },
      h('span', { class: 'bubble-turn-label' }, 'Text'),
      icon('chevron-down', 13),
    );
    this.turnInto.addEventListener('click', () => this.openTurnInto());

    this.buttons = MARKS.map((mark) => {
      const button = h(
        'button',
        { class: 'bubble-button', type: 'button', title: mark.title, 'aria-label': mark.title },
        icon(mark.icon, 15),
      );
      button.addEventListener('click', () => mark.run(editor.chain().focus()).run());
      return { mark, button };
    });
    this.linkButton = h(
      'button',
      {
        class: 'bubble-button',
        type: 'button',
        title: `Link (${kbd('Mod+K')})`,
        'aria-label': 'Link',
      },
      icon('link', 15),
    );
    this.linkButton.addEventListener('click', () => {
      this.hide();
      openLinkEditor(editor);
    });

    this.el = h(
      'div',
      { class: 'popover bubble-toolbar', role: 'toolbar', 'aria-label': 'Formatting' },
      this.turnInto,
      h('span', { class: 'bubble-separator' }),
      this.buttons.map((entry) => entry.button),
      h('span', { class: 'bubble-separator' }),
      this.linkButton,
    );
    this.el.hidden = true;
    // Keep the text selection when pressing toolbar buttons.
    this.el.addEventListener('mousedown', (event) => event.preventDefault());
    document.body.append(this.el);

    // While the mouse is down the selection is still changing: wait.
    view.dom.addEventListener(
      'mousedown',
      () => {
        this.pointerDown = true;
        this.hide();
      },
      { signal },
    );
    document.addEventListener(
      'mouseup',
      () => {
        if (!this.pointerDown) return;
        this.pointerDown = false;
        // Let the editor settle its selection first.
        setTimeout(() => this.refresh(), 0);
      },
      { signal },
    );
    view.dom.addEventListener('blur', () => setTimeout(() => this.onBlur(), 0), { signal });
    window.addEventListener('resize', () => this.place(), { signal });
    document.addEventListener('scroll', () => this.place(), {
      capture: true,
      passive: true,
      signal,
    });
  }

  shouldShow() {
    const { editor, view } = this;
    const { selection } = view.state;
    if (!editor.isEditable || this.pointerDown || !view.hasFocus()) return false;
    if (!(selection instanceof TextSelection) || selection.empty) return false;
    if (selection.$from.parent.type.spec.code) return false;
    return view.state.doc.textBetween(selection.from, selection.to, ' ').trim().length > 0;
  }

  refresh() {
    if (this.view.isDestroyed) return;
    if (!this.shouldShow()) {
      if (!this.menu) this.hide();
      return;
    }
    for (const { mark, button } of this.buttons) {
      button.classList.toggle('is-on', this.editor.isActive(mark.name));
    }
    this.linkButton.classList.toggle('is-on', this.editor.isActive('link'));
    this.turnInto.firstChild.textContent = currentBlockLabel(this.editor);
    this.el.hidden = false;
    this.place();
  }

  place() {
    if (this.el.hidden || this.view.isDestroyed) return;
    const { from, to } = this.view.state.selection;
    const start = this.view.coordsAtPos(from);
    const end = this.view.coordsAtPos(to, -1);
    const top = Math.min(start.top, end.top);
    const left = Math.min(start.left, end.left);
    const right = Math.max(start.right, end.right);
    const bottom = Math.max(start.bottom, end.bottom);
    const rect = new DOMRect(left, top, Math.max(right - left, 1), bottom - top);
    positionElement(this.el, () => rect, 'top-center', 8);
  }

  hide() {
    this.el.hidden = true;
  }

  onBlur() {
    // Focus moving into the toolbar's own menu must not close the toolbar.
    if (this.menu || this.el.contains(document.activeElement)) return;
    this.hide();
  }

  openTurnInto() {
    if (this.menu) return;
    const { editor } = this;
    this.menu = openMenu({
      anchor: this.turnInto,
      items: CONVERTIBLE_BLOCKS.map((block) => ({
        label: block.title,
        icon: block.icon,
        checked: block.isActive(editor),
        onSelect: () => applyBlock(editor, block),
      })),
      onClose: () => {
        this.menu = null;
        setTimeout(() => this.refresh(), 0);
      },
    });
  }

  update(view) {
    this.view = view;
    this.refresh();
  }

  destroy() {
    this.controller.abort();
    this.menu?.close({ focus: false });
    this.el.remove();
  }
}

export const BubbleToolbar = Extension.create({
  name: 'bubbleToolbar',

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('bubbleToolbar'),
        view: (view) => new BubbleToolbarView(view, editor),
      }),
    ];
  },
});
