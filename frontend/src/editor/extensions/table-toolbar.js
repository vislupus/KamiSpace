// A compact toolbar above the table that contains the caret.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';

const ACTIONS = [
  { icon: 'row-add', title: 'Add row below', run: (c) => c.addRowAfter() },
  { icon: 'column-add', title: 'Add column right', run: (c) => c.addColumnAfter() },
  { icon: 'rows', title: 'Delete row', run: (c) => c.deleteRow() },
  { icon: 'columns', title: 'Delete column', run: (c) => c.deleteColumn() },
  { icon: 'h1', title: 'Toggle header row', run: (c) => c.toggleHeaderRow() },
  { icon: 'trash-2', title: 'Delete table', run: (c) => c.deleteTable(), danger: true },
];

class TableToolbarView {
  constructor(view, editor) {
    this.view = view;
    this.editor = editor;
    this.container = view.dom.parentElement;
    this.el = h(
      'div',
      { class: 'table-toolbar', role: 'toolbar', 'aria-label': 'Table', contentEditable: 'false' },
      ACTIONS.map((action) => {
        const button = h(
          'button',
          {
            class: `bubble-button${action.danger ? ' is-danger' : ''}`,
            type: 'button',
            title: action.title,
            'aria-label': action.title,
          },
          icon(action.icon, 15),
        );
        button.addEventListener('mousedown', (event) => event.preventDefault());
        button.addEventListener('click', () => action.run(editor.chain().focus()).run());
        return button;
      }),
    );
    this.el.hidden = true;
    this.container.append(this.el);
  }

  update(view) {
    this.view = view;
    const { $from } = view.state.selection;
    let tablePos = null;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if ($from.node(depth).type.name === 'table') {
        tablePos = $from.before(depth);
        break;
      }
    }
    const dom = tablePos === null ? null : view.nodeDOM(tablePos);
    if (!this.editor.isEditable || !(dom instanceof HTMLElement) || !view.hasFocus()) {
      this.el.hidden = true;
      return;
    }
    const rect = dom.getBoundingClientRect();
    const containerRect = this.container.getBoundingClientRect();
    this.el.hidden = false;
    this.el.style.top = `${Math.round(rect.top - containerRect.top - this.el.offsetHeight - 4)}px`;
    this.el.style.left = `${Math.round(rect.left - containerRect.left)}px`;
  }

  destroy() {
    this.el.remove();
  }
}

export const TableToolbar = Extension.create({
  name: 'tableToolbar',

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('tableToolbar'),
        view: (view) => new TableToolbarView(view, editor),
      }),
    ];
  },
});
