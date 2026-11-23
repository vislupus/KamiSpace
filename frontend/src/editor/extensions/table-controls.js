// Simple tables that work the way Notion's do. Nothing is shown until the
// pointer is over a table; then
//   - a bar on the right adds a column and a bar below adds a row
//     (click for one, drag for several — dragging back removes empty ones),
//   - a small handle on the top edge of the column and on the left edge of
//     the row under the pointer opens a menu (insert, clear, delete, header)
//     and can be dragged to move the column or row,
//   - the cell with the caret gets a blue frame,
//   - Enter goes to the cell below (Shift+Enter breaks the line), Tab to the
//     next cell.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import {
  CellSelection,
  TableMap,
  cellAround,
  columnIsHeader,
  moveTableColumn,
  moveTableRow,
  rowIsHeader,
} from '@tiptap/pm/tables';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { openMenu } from '../../lib/menu.js';

const DRAG_START = 5; // pixels before a press on a handle becomes a drag
const COLUMN_STEP = 110; // pixels of dragging per column added or removed
const ROW_STEP = 34;

/** The table around a cell element: node, position of its content, cell map and the cell's place in it. */
function locate(view, cellDom) {
  let $cell;
  try {
    $cell = cellAround(view.state.doc.resolve(view.posAtDOM(cellDom, 0)));
  } catch {
    return null;
  }
  if (!$cell) return null;
  const table = $cell.node(-1);
  const start = $cell.start(-1);
  const map = TableMap.get(table);
  const rect = map.findCell($cell.pos - start);
  return { table, start, map, row: rect.top, column: rect.left };
}

/** Positions (in the document) of the cells of a row or a column, each once. */
function cellsOf(found, axis, index) {
  const { map, start } = found;
  const positions = new Set();
  const count = axis === 'row' ? map.width : map.height;
  for (let other = 0; other < count; other += 1) {
    const offset = axis === 'row' ? map.map[index * map.width + other] : map.map[other * map.width + index];
    positions.add(start + offset);
  }
  return [...positions];
}

function isEmptyLine(found, axis, index, doc) {
  return cellsOf(found, axis, index).every((pos) => doc.nodeAt(pos)?.textContent === '' && !doc.nodeAt(pos)?.firstChild?.firstChild);
}

class TableControlsView {
  constructor(view, editor) {
    this.view = view;
    this.editor = editor;
    this.container = view.dom.parentElement;
    this.tableDom = null;
    this.cellDom = null;
    this.busy = false; // a menu is open or something is being dragged
    this.hideTimer = 0;

    this.columnHandle = this.handle('column', 'Column: click for options, drag to move');
    this.rowHandle = this.handle('row', 'Row: click for options, drag to move');
    this.addColumn = this.bar('column', 'Click to add a column, drag to add or remove several');
    this.addRow = this.bar('row', 'Click to add a row, drag to add or remove several');
    this.indicator = h('div', { class: 'table-move-line', hidden: true });
    this.elements = [this.columnHandle, this.rowHandle, this.addColumn, this.addRow];
    this.container.append(...this.elements, this.indicator);
    this.hide();

    this.onMove = (event) => this.pointerMoved(event);
    this.onLeave = () => this.scheduleHide();
    this.container.addEventListener('mousemove', this.onMove);
    this.container.addEventListener('mouseleave', this.onLeave);
  }

  // -- elements -------------------------------------------------------------------

  handle(axis, title) {
    const el = h(
      'button',
      { class: `table-handle table-handle-${axis}`, type: 'button', title, 'aria-label': title, contentEditable: 'false' },
      icon('more', 12),
    );
    el.addEventListener('mousedown', (event) => event.preventDefault());
    el.addEventListener('pointerdown', (event) => this.pressHandle(event, axis, el));
    return el;
  }

  bar(axis, title) {
    const el = h(
      'button',
      { class: `table-add table-add-${axis}`, type: 'button', title, 'aria-label': axis === 'column' ? 'Add a column' : 'Add a row', contentEditable: 'false' },
      icon('plus', 13),
    );
    el.addEventListener('mousedown', (event) => event.preventDefault());
    el.addEventListener('pointerdown', (event) => this.pressBar(event, axis, el));
    return el;
  }

  // -- showing and hiding -----------------------------------------------------------

  pointerMoved(event) {
    if (this.busy || !this.editor.isEditable) return;
    if (this.elements.some((el) => el.contains(event.target))) {
      clearTimeout(this.hideTimer);
      return;
    }
    const cell = event.target.closest?.('td, th');
    if (cell && this.view.dom.contains(cell)) {
      clearTimeout(this.hideTimer);
      this.cellDom = cell;
      this.tableDom = cell.closest('table');
      this.place();
      return;
    }
    // Between the table and its controls the pointer crosses a few pixels of nothing.
    if (this.tableDom) {
      const rect = this.tableDom.getBoundingClientRect();
      const near =
        event.clientX >= rect.left - 22 && event.clientX <= rect.right + 30 &&
        event.clientY >= rect.top - 18 && event.clientY <= rect.bottom + 30;
      if (near) {
        clearTimeout(this.hideTimer);
        return;
      }
    }
    this.scheduleHide();
  }

  scheduleHide() {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (!this.busy) this.hide();
    }, 160);
  }

  hide() {
    for (const el of this.elements) el.hidden = true;
    this.tableDom = null;
    this.cellDom = null;
  }

  place() {
    const { tableDom, cellDom } = this;
    if (!tableDom?.isConnected || !cellDom?.isConnected || !this.editor.isEditable) {
      this.hide();
      return;
    }
    const base = this.container.getBoundingClientRect();
    const table = tableDom.getBoundingClientRect();
    const cell = cellDom.getBoundingClientRect();
    // A wide table scrolls inside its wrapper: keep the controls at its visible edge.
    const wrapper = (tableDom.closest('.tableWrapper') ?? tableDom).getBoundingClientRect();
    const right = Math.min(table.right, wrapper.right);
    const left = Math.max(table.left, wrapper.left);
    const set = (el, box) => {
      el.hidden = false;
      Object.assign(el.style, {
        left: `${Math.round(box.left - base.left)}px`,
        top: `${Math.round(box.top - base.top)}px`,
        width: box.width ? `${Math.round(box.width)}px` : '',
        height: box.height ? `${Math.round(box.height)}px` : '',
      });
    };
    const columnCentre = cell.left + cell.width / 2;
    if (columnCentre >= left && columnCentre <= right) set(this.columnHandle, { left: columnCentre - 13, top: table.top - 8 });
    else this.columnHandle.hidden = true;
    set(this.rowHandle, { left: left - 8, top: cell.top + cell.height / 2 - 13 });
    set(this.addColumn, { left: right + 4, top: table.top, height: table.height });
    set(this.addRow, { left, top: table.bottom + 2, width: right - left });
  }

  // -- changing the table -------------------------------------------------------------

  found() {
    return this.cellDom?.isConnected ? locate(this.view, this.cellDom) : null;
  }

  /** Run a table command with the caret in the given cell. */
  run(cellPos, command) {
    return this.editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .command(({ tr }) => {
        tr.setSelection(Selection.near(tr.doc.resolve(cellPos + 1)));
        return true;
      })
      [command]()
      .run();
  }

  /** The table as it is now (after a change), found again through its position. */
  refreshed(start) {
    const { doc } = this.view.state;
    const table = doc.resolve(start).node();
    return table?.type.name === 'table' ? { table, start, map: TableMap.get(table) } : null;
  }

  append(axis, start) {
    const found = this.refreshed(start);
    if (!found) return false;
    const { map } = found;
    const cell = axis === 'column' ? map.map[map.width - 1] : map.map[(map.height - 1) * map.width];
    return this.run(start + cell, axis === 'column' ? 'addColumnAfter' : 'addRowAfter');
  }

  /** Remove the last column or row, but only while it is empty. */
  removeLast(axis, start) {
    const found = this.refreshed(start);
    if (!found) return false;
    const { map } = found;
    const count = axis === 'column' ? map.width : map.height;
    if (count <= 1) return false;
    if (!isEmptyLine(found, axis === 'column' ? 'column' : 'row', count - 1, this.view.state.doc)) return false;
    const cell = axis === 'column' ? map.map[map.width - 1] : map.map[(map.height - 1) * map.width];
    return this.run(start + cell, axis === 'column' ? 'deleteColumn' : 'deleteRow');
  }

  clear(found, axis, index) {
    const { state } = this.view;
    const tr = state.tr;
    const paragraph = state.schema.nodes.paragraph;
    for (const pos of cellsOf(found, axis, index).sort((a, b) => b - a)) {
      const cell = tr.doc.nodeAt(pos);
      if (cell) tr.replaceWith(pos + 1, pos + cell.nodeSize - 1, paragraph.create());
    }
    if (tr.docChanged) this.view.dispatch(tr);
    this.view.focus();
  }

  // -- the "+" bars ---------------------------------------------------------------------

  pressBar(event, axis, el) {
    if (event.button !== 0) return;
    const found = this.found();
    if (!found) return;
    event.preventDefault();
    const { start } = found;
    const origin = axis === 'column' ? event.clientX : event.clientY;
    const step = axis === 'column' ? COLUMN_STEP : ROW_STEP;
    let applied = 0;
    let dragged = false;
    this.busy = true;
    el.setPointerCapture(event.pointerId);
    el.classList.add('is-active');
    const move = (moveEvent) => {
      const wanted = Math.round(((axis === 'column' ? moveEvent.clientX : moveEvent.clientY) - origin) / step);
      if (wanted !== 0) dragged = true;
      while (applied < wanted && this.append(axis, start)) applied += 1;
      while (applied > wanted && this.removeLast(axis, start)) applied -= 1;
      if (applied > wanted) dragged = true; // nothing empty left to remove
      this.place();
    };
    const stop = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', stop);
      el.removeEventListener('pointercancel', stop);
      el.classList.remove('is-active');
      this.busy = false;
      if (!dragged) {
        this.append(axis, start);
        // Start writing in the new row straight away.
        const after = this.refreshed(start);
        if (after && axis === 'row') {
          const cell = after.map.map[(after.map.height - 1) * after.map.width];
          this.editor.commands.setTextSelection(start + cell + 2);
        }
      }
      requestAnimationFrame(() => this.place());
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
  }

  // -- handles: menu on click, move on drag ---------------------------------------------

  pressHandle(event, axis, el) {
    if (event.button !== 0) return;
    const found = this.found();
    if (!found) return;
    event.preventDefault();
    const index = axis === 'column' ? found.column : found.row;
    const startX = event.clientX;
    const startY = event.clientY;
    let target = null;
    let dragging = false;
    this.busy = true;
    el.setPointerCapture(event.pointerId);

    const lines = () => {
      // Boundaries between the rows or columns, read from the first row / column.
      const rows = [...this.tableDom.rows];
      const cells = axis === 'column' ? [...rows[0].cells] : rows.map((row) => row.cells[0]);
      return cells.map((cell) => cell.getBoundingClientRect());
    };
    const move = (moveEvent) => {
      if (!dragging && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_START) return;
      dragging = true;
      el.classList.add('is-active');
      const boxes = lines();
      const point = axis === 'column' ? moveEvent.clientX : moveEvent.clientY;
      target = boxes.findIndex((box) => point < (axis === 'column' ? box.left + box.width / 2 : box.top + box.height / 2));
      if (target < 0) target = boxes.length;
      const table = this.tableDom.getBoundingClientRect();
      const base = this.container.getBoundingClientRect();
      const edge = target < boxes.length
        ? (axis === 'column' ? boxes[target].left : boxes[target].top)
        : (axis === 'column' ? boxes.at(-1).right : boxes.at(-1).bottom);
      this.indicator.hidden = false;
      Object.assign(
        this.indicator.style,
        axis === 'column'
          ? { left: `${edge - base.left - 1}px`, top: `${table.top - base.top}px`, width: '3px', height: `${table.height}px` }
          : { left: `${table.left - base.left}px`, top: `${edge - base.top - 1}px`, width: `${table.width}px`, height: '3px' },
      );
    };
    const stop = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', stop);
      el.removeEventListener('pointercancel', stop);
      el.classList.remove('is-active');
      this.indicator.hidden = true;
      this.busy = false;
      if (!dragging) {
        this.openMenu(axis, el, found, index);
        return;
      }
      // Dropping just before or after itself changes nothing.
      const to = target > index ? target - 1 : target;
      if (target !== null && to !== index) {
        // The move works from the selection, which has to be inside this table.
        const { view } = this;
        view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(found.start + 1))));
        const command = axis === 'column' ? moveTableColumn : moveTableRow;
        command({ from: index, to, pos: found.start + 1, select: false })(view.state, view.dispatch);
        view.focus();
      }
      this.hide();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
  }

  openMenu(axis, anchor, found, index) {
    const { map, table, start } = found;
    const isColumn = axis === 'column';
    const cell = start + (isColumn ? map.map[index] : map.map[index * map.width]);
    const header = isColumn ? columnIsHeader(map, table, index) : rowIsHeader(map, table, index);
    const only = (isColumn ? map.width : map.height) === 1;
    this.busy = true;
    anchor.classList.add('is-active');
    openMenu({
      anchor,
      placement: isColumn ? 'bottom-start' : 'right-start',
      items: [
        index === 0
          ? {
              label: isColumn ? 'Header column' : 'Header row',
              icon: isColumn ? 'columns' : 'rows',
              checked: header,
              onSelect: () => this.run(cell, isColumn ? 'toggleHeaderColumn' : 'toggleHeaderRow'),
            }
          : null,
        index === 0 ? { separator: true } : null,
        {
          label: isColumn ? 'Insert left' : 'Insert above',
          icon: isColumn ? 'column-add' : 'row-add',
          onSelect: () => this.run(cell, isColumn ? 'addColumnBefore' : 'addRowBefore'),
        },
        {
          label: isColumn ? 'Insert right' : 'Insert below',
          icon: isColumn ? 'column-add' : 'row-add',
          onSelect: () => this.run(cell, isColumn ? 'addColumnAfter' : 'addRowAfter'),
        },
        { label: 'Clear contents', icon: 'x', onSelect: () => this.clear(found, axis, index) },
        { separator: true },
        {
          label: only ? 'Delete table' : isColumn ? 'Delete column' : 'Delete row',
          icon: 'trash-2',
          danger: true,
          onSelect: () => this.run(cell, only ? 'deleteTable' : isColumn ? 'deleteColumn' : 'deleteRow'),
        },
      ],
      onClose: () => {
        this.busy = false;
        anchor.classList.remove('is-active');
        this.hide();
      },
    });
  }

  update() {
    // The table may have changed size or moved (typing, undo, another block growing).
    if (this.tableDom) this.place();
  }

  destroy() {
    clearTimeout(this.hideTimer);
    this.container.removeEventListener('mousemove', this.onMove);
    this.container.removeEventListener('mouseleave', this.onLeave);
    for (const el of [...this.elements, this.indicator]) el.remove();
  }
}

/** The cell the caret is in, to frame it. */
function currentCell(state) {
  const { selection } = state;
  if (selection instanceof CellSelection || !selection.empty) return null;
  const $cell = cellAround(selection.$from);
  return $cell ? { pos: $cell.pos, node: $cell.nodeAfter } : null;
}

export const TableControls = Extension.create({
  name: 'tableControls',
  // Before the list and hard-break bindings for Enter.
  priority: 200,

  addKeyboardShortcuts() {
    return {
      // Enter moves down a row, as in a spreadsheet; Shift+Enter breaks the line.
      Enter: () => {
        const { state } = this.editor;
        const { selection } = state;
        if (!selection.empty) return false;
        const $cell = cellAround(selection.$from);
        if (!$cell) return false;
        // Lists and code inside a cell keep their own Enter.
        for (let depth = selection.$from.depth; depth > $cell.depth; depth -= 1) {
          const node = selection.$from.node(depth);
          if (node.type.spec.code || ['listItem', 'taskItem', 'detailsSummary'].includes(node.type.name)) return false;
        }
        const table = $cell.node(-1);
        const start = $cell.start(-1);
        const map = TableMap.get(table);
        const rect = map.findCell($cell.pos - start);
        if (rect.bottom >= map.height) {
          // The last row: a new one is added, and the caret goes there.
          if (!this.editor.chain().addRowAfter().run()) return false;
          const grown = this.editor.state.doc.resolve(start).node();
          const below = TableMap.get(grown).map[map.height * map.width + rect.left];
          return this.editor.commands.setTextSelection(start + below + 2);
        }
        const below = map.map[rect.bottom * map.width + rect.left];
        return this.editor.commands.setTextSelection(start + below + 2);
      },
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('tableControls'),
        view: (view) => new TableControlsView(view, editor),
        props: {
          decorations(state) {
            if (!editor.isEditable) return null;
            const cell = currentCell(state);
            if (!cell) return null;
            return DecorationSet.create(state.doc, [
              Decoration.node(cell.pos, cell.pos + cell.node.nodeSize, { class: 'is-current-cell' }),
            ]);
          },
        },
      }),
    ];
  },
});
