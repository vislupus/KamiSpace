// Table view of a database: one row per page, one column per property.
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { openMenu } from '../../lib/menu.js';
import { CALCULATIONS, TYPES, calculate, editValue, renderValue, valueOf } from './values.js';

const MIN_WIDTH = 80;
const ADD_COLUMN = 44;

function defaultWidth(prop) {
  if (prop.type === 'title') return 280;
  if (prop.type === 'checkbox') return 110;
  return prop.type === 'number' ? 140 : 180;
}

/** Which side of `element` the pointer is on, along one axis. */
function side(event, element, axis = 'y') {
  const rect = element.getBoundingClientRect();
  return axis === 'y'
    ? event.clientY < rect.top + rect.height / 2
    : event.clientX < rect.left + rect.width / 2;
}

export function renderTable(ctx) {
  const { view, rows, properties, canEdit } = ctx;
  const widths = { ...(view.widths ?? {}) };
  const wrapped = new Set(view.wrap ?? []);
  const widthOf = (prop) => widths[prop.id] ?? defaultWidth(prop);
  const table = h('div', { class: 'db-table', role: 'table' });
  const applyWidths = () => {
    const columns = properties.map((prop) => `${widthOf(prop)}px`);
    table.style.setProperty('--db-columns', [...columns, canEdit ? `${ADD_COLUMN}px` : '0px'].join(' '));
    table.style.minWidth = `${properties.reduce((total, prop) => total + widthOf(prop), canEdit ? ADD_COLUMN : 0)}px`;
  };
  applyWidths();

  // -- header ---------------------------------------------------------------------
  let draggedHeader = null;
  const header = h(
    'div',
    { class: 'db-row db-head', role: 'row' },
    properties.map((prop) => {
      const cell = h(
        'div',
        {
          class: 'db-th',
          role: 'columnheader',
          dataset: { header: prop.id },
          draggable: canEdit && prop.type !== 'title',
          title: prop.name,
        },
        icon(TYPES[prop.type].icon, 14),
        h('span', { class: 'db-th-name' }, prop.name),
      );
      if (!canEdit) return cell;
      cell.addEventListener('click', (event) => {
        if (!event.target.closest('.db-resize')) ctx.propertyMenu(prop, cell);
      });
      cell.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        ctx.propertyMenu(prop, cell, { at: { x: event.clientX, y: event.clientY } });
      });
      // Drag a header onto another to reorder the columns.
      cell.addEventListener('dragstart', (event) => {
        draggedHeader = prop.id;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', prop.name);
      });
      cell.addEventListener('dragover', (event) => {
        if (!draggedHeader || draggedHeader === prop.id || prop.type === 'title') return;
        event.preventDefault();
        cell.dataset.drop = side(event, cell, 'x') ? 'before' : 'after';
      });
      cell.addEventListener('dragleave', () => delete cell.dataset.drop);
      cell.addEventListener('drop', (event) => {
        event.preventDefault();
        const before = cell.dataset.drop === 'before';
        delete cell.dataset.drop;
        if (!draggedHeader || draggedHeader === prop.id) return;
        const order = properties.map((item) => item.id).filter((id) => id !== draggedHeader);
        order.splice(order.indexOf(prop.id) + (before ? 0 : 1), 0, draggedHeader);
        draggedHeader = null;
        ctx.changeView({ order });
      });
      cell.addEventListener('dragend', () => {
        draggedHeader = null;
      });

      const grip = h('div', { class: 'db-resize', title: 'Drag to resize', 'aria-hidden': 'true' });
      grip.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const start = event.clientX;
        const original = widthOf(prop);
        grip.setPointerCapture(event.pointerId);
        table.classList.add('is-resizing');
        const move = (moveEvent) => {
          widths[prop.id] = Math.max(MIN_WIDTH, Math.round(original + moveEvent.clientX - start));
          applyWidths();
        };
        const stop = () => {
          grip.removeEventListener('pointermove', move);
          grip.removeEventListener('pointerup', stop);
          grip.removeEventListener('pointercancel', stop);
          table.classList.remove('is-resizing');
          if (widthOf(prop) !== original) ctx.changeView({ widths });
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', stop);
        grip.addEventListener('pointercancel', stop);
      });
      cell.append(grip);
      return cell;
    }),
    canEdit
      ? h(
          'button',
          {
            class: 'db-th db-th-add',
            type: 'button',
            title: 'Add a property',
            'aria-label': 'Add a property',
            onclick: (event) => ctx.addProperty(event.currentTarget),
          },
          icon('plus', 15),
        )
      : h('div'),
  );
  table.append(header);

  // -- rows -----------------------------------------------------------------------
  // One line per row, kept by row id: a change to one row redraws that line
  // only, however long the table is.
  const lines = new Map();
  let shown = rows;
  let draggedRow = null;

  /** Open the editor of one cell. */
  function editCell(row, prop, cell) {
    if (prop.type === 'formula') {
      if (canEdit) ctx.editFormula(prop, cell);
      return;
    }
    const isTitle = prop.type === 'title';
    editValue(prop, valueOf(row, prop), cell, {
      onChange: (next) => ctx.updateRow(row, isTitle ? { title: next ?? '' } : { props: { [prop.id]: next } }),
      onProperty: ctx.saveProperty,
      // Tab and Shift+Tab go on to the next cell, the way a spreadsheet does.
      onTab: (step) => editNext(row, prop, step),
    });
  }

  function editNext(row, prop, step) {
    let rowIndex = shown.findIndex((item) => item.id === row.id);
    let propIndex = properties.findIndex((item) => item.id === prop.id);
    if (rowIndex < 0 || propIndex < 0) return;
    for (let guard = 0; guard < 5000; guard += 1) {
      propIndex += step;
      if (propIndex >= properties.length) {
        propIndex = 0;
        rowIndex += 1;
      } else if (propIndex < 0) {
        propIndex = properties.length - 1;
        rowIndex -= 1;
      }
      const target = shown[rowIndex];
      if (!target) return;
      const next = properties[propIndex];
      // A checkbox is ticked with a click and a formula is calculated.
      if (!target.can_edit || next.type === 'checkbox' || next.type === 'formula') continue;
      edit(target.id, next.id);
      return;
    }
  }

  /** Start editing a cell by row and property id (the name of a new row, the next cell after Tab). */
  function edit(rowId, propId) {
    const row = shown.find((item) => item.id === rowId);
    const prop = properties.find((item) => item.id === propId);
    const cell = lines.get(rowId)?.querySelector(`[data-prop="${propId}"]`);
    if (!row || !prop || !cell || !canEdit || !row.can_edit) return;
    cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    editCell(row, prop, cell);
  }

  function renderLine(row) {
    const editable = canEdit && row.can_edit;
    const line = h('div', {
      class: `db-row${ctx.peekedId === row.id ? ' is-peeked' : ''}`,
      role: 'row',
      dataset: { row: row.id, ...(row.color ? { color: row.color } : {}) },
    });
    // Right click: everything that can be done with the row.
    line.addEventListener('contextmenu', (event) => {
      if (event.target.closest('a[href], input, textarea')) return;
      event.preventDefault();
      ctx.rowMenu(row, line, { at: { x: event.clientX, y: event.clientY } });
    });

    if (editable) {
      const handle = h(
        'button',
        {
          class: 'db-row-handle',
          type: 'button',
          draggable: !ctx.sorted,
          title: ctx.sorted ? 'Click for options (remove the sort to reorder)' : 'Drag to move, click for options',
          'aria-label': 'Row options',
        },
        icon('grip', 14),
      );
      handle.addEventListener('click', () => ctx.rowMenu(row, handle));
      handle.addEventListener('dragstart', (event) => {
        draggedRow = row;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', row.title || 'Untitled');
        event.dataTransfer.setDragImage(line, 0, 0);
      });
      handle.addEventListener('dragend', () => {
        draggedRow = null;
      });
      line.append(handle);
      line.addEventListener('dragover', (event) => {
        if (!draggedRow || draggedRow.id === row.id) return;
        event.preventDefault();
        line.dataset.drop = side(event, line) ? 'before' : 'after';
      });
      line.addEventListener('dragleave', () => delete line.dataset.drop);
      line.addEventListener('drop', (event) => {
        event.preventDefault();
        const before = line.dataset.drop === 'before';
        delete line.dataset.drop;
        if (!draggedRow || draggedRow.id === row.id) return;
        const moved = draggedRow;
        draggedRow = null;
        ctx.moveRow(moved, before ? { beforeId: row.id } : { afterId: row.id });
      });
    }

    for (const prop of properties) {
      const isTitle = prop.type === 'title';
      const cell = h(
        'div',
        {
          class: `db-cell${isTitle ? ' db-cell-title' : ''}${editable ? ' is-editable' : ''}${wrapped.has(prop.id) ? ' is-wrapped' : ''}`,
          role: 'cell',
          dataset: { prop: prop.id, type: prop.type },
        },
        isTitle && row.color ? h('span', { class: 'db-row-color', 'aria-hidden': 'true' }) : null,
        isTitle && row.icon ? h('span', { class: 'db-row-icon' }, row.icon) : null,
        isTitle && !row.icon && row.has_content ? h('span', { class: 'db-row-icon' }, icon('file-text', 14)) : null,
        renderValue(prop, valueOf(row, prop)) ?? (isTitle ? h('span', { class: 'db-text db-untitled' }, 'Untitled') : null),
      );
      if (isTitle) {
        const open = h(
          'button',
          {
            class: 'db-open-row',
            type: 'button',
            title: 'Open in side peek (Ctrl+click: new tab)',
            onclick: (event) => {
              event.stopPropagation();
              ctx.openRow(row, event);
            },
            onauxclick: (event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              ctx.openRow(row, event);
            },
          },
          icon('external', 12),
          'Open',
        );
        cell.append(open);
        // A viewer cannot edit, so the whole cell opens the page.
        if (!editable) cell.addEventListener('click', (event) => ctx.openRow(row, event));
        // The middle button on the name opens the row in a new tab.
        cell.addEventListener('auxclick', (event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          ctx.openRow(row, event);
        });
        cell.addEventListener('mousedown', (event) => {
          if (event.button === 1) event.preventDefault();
        });
      }
      if (editable) cell.addEventListener('click', () => editCell(row, prop, cell));
      line.append(cell);
    }
    line.append(h('div', { class: 'db-cell db-cell-end' }));
    return line;
  }

  // -- footer ---------------------------------------------------------------------
  const addButton = canEdit
    ? h('button', { class: 'db-add-row', type: 'button', onclick: () => ctx.addRow() }, icon('plus', 14), 'New page')
    : null;
  const emptyNote = h('div', { class: 'db-empty', hidden: true }, 'No rows match the filters or the search.');
  const calc = view.calc ?? {};

  function renderCalc() {
    return h(
      'div',
      { class: 'db-row db-calc', role: 'row' },
      properties.map((prop) => {
        const name = calc[prop.id];
        const label = CALCULATIONS.find(([key]) => key === name)?.[1];
        const result = name ? calculate(name, shown, prop) : null;
        const cell = h(
          canEdit ? 'button' : 'div',
          { class: `db-calc-cell${name ? ' is-set' : ''}`, type: canEdit ? 'button' : null, dataset: { calc: prop.id } },
          name
            ? [h('span', { class: 'db-calc-label' }, label), h('span', { class: 'db-calc-value' }, result ?? '–')]
            : canEdit
              ? h('span', { class: 'db-calc-label' }, 'Calculate')
              : null,
        );
        if (canEdit) {
          cell.addEventListener('click', () =>
            openMenu({
              anchor: cell,
              items: [
                { label: 'None', checked: !name, onSelect: () => ctx.changeView({ calc: { ...calc, [prop.id]: undefined } }) },
                ...CALCULATIONS.map(([key, text]) => ({
                  label: text,
                  checked: key === name,
                  onSelect: () => ctx.changeView({ calc: { ...calc, [prop.id]: key } }),
                })),
              ],
            }),
          );
        }
        return cell;
      }),
      h('div'),
    );
  }

  let calcRow = renderCalc();
  const hasCalc = Object.values(calc).some(Boolean);
  for (const row of rows) {
    const line = renderLine(row);
    lines.set(row.id, line);
    table.append(line);
  }
  if (addButton) table.append(addButton);
  emptyNote.hidden = Boolean(rows.length) || !ctx.db.rows.length;
  table.append(emptyNote, calcRow);

  /**
   * Show these rows, in this order. Lines of rows that did not change stay
   * as they are; `dirty` holds the ids of rows to draw again.
   */
  function sync(nextRows, dirty = new Set()) {
    shown = nextRows;
    const wanted = new Set(nextRows.map((row) => row.id));
    for (const [id, line] of lines) {
      if (wanted.has(id)) continue;
      line.remove();
      lines.delete(id);
    }
    let previous = header;
    for (const row of nextRows) {
      let line = lines.get(row.id);
      if (!line || dirty.has(row.id)) {
        const fresh = renderLine(row);
        if (line) line.replaceWith(fresh);
        line = fresh;
        lines.set(row.id, line);
      }
      if (previous.nextSibling !== line) previous.after(line);
      previous = line;
    }
    emptyNote.hidden = Boolean(nextRows.length) || !ctx.db.rows.length;
    if (hasCalc) {
      const fresh = renderCalc();
      calcRow.replaceWith(fresh);
      calcRow = fresh;
    }
  }

  if (canEdit && ctx.editTitleOf) setTimeout(() => table.isConnected && edit(ctx.editTitleOf, 'title'), 0);

  return { el: h('div', { class: 'db-scroll' }, table), sync, edit };
}
