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
  let draggedRow = null;
  for (const row of rows) {
    const editable = canEdit && row.can_edit;
    const line = h('div', { class: 'db-row', role: 'row', dataset: { row: row.id } });

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
      handle.addEventListener('click', () =>
        openMenu({
          anchor: handle,
          items: [
            { label: 'Open', icon: 'external', onSelect: () => ctx.openRow(row) },
            { label: 'Add a row below', icon: 'plus', onSelect: () => ctx.addRow({ afterId: row.id }) },
            { separator: true },
            { label: 'Delete', icon: 'trash-2', danger: true, onSelect: () => ctx.deleteRow(row) },
          ],
        }),
      );
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
      const value = valueOf(row, prop);
      const isTitle = prop.type === 'title';
      const cell = h(
        'div',
        {
          class: `db-cell${isTitle ? ' db-cell-title' : ''}${editable ? ' is-editable' : ''}`,
          role: 'cell',
          dataset: { prop: prop.id, type: prop.type },
        },
        isTitle && row.icon ? h('span', { class: 'db-row-icon' }, row.icon) : null,
        isTitle && !row.icon && row.has_content ? h('span', { class: 'db-row-icon' }, icon('file-text', 14)) : null,
        renderValue(prop, value) ?? (isTitle ? h('span', { class: 'db-text db-untitled' }, 'Untitled') : null),
      );
      const edit = () =>
        editValue(prop, value, cell, {
          onChange: (next) => ctx.updateRow(row, isTitle ? { title: next ?? '' } : { props: { [prop.id]: next } }),
          onProperty: ctx.saveProperty,
        });
      if (isTitle) {
        const open = h(
          'button',
          {
            class: 'db-open-row',
            type: 'button',
            title: 'Open this page',
            onclick: (event) => {
              event.stopPropagation();
              ctx.openRow(row);
            },
          },
          icon('external', 12),
          'Open',
        );
        cell.append(open);
        // A viewer cannot edit, so the whole cell opens the page.
        if (!editable) cell.addEventListener('click', () => ctx.openRow(row));
        if (editable && ctx.editTitleOf === row.id) setTimeout(() => cell.isConnected && edit(), 0);
      }
      if (editable) cell.addEventListener('click', edit);
      line.append(cell);
    }
    line.append(h('div', { class: 'db-cell db-cell-end' }));
    table.append(line);
  }

  // -- footer ---------------------------------------------------------------------
  if (canEdit) {
    table.append(
      h(
        'button',
        { class: 'db-add-row', type: 'button', onclick: () => ctx.addRow() },
        icon('plus', 14),
        'New page',
      ),
    );
  }
  if (!rows.length && ctx.db.rows.length) {
    table.append(h('div', { class: 'db-empty' }, 'No rows match the filters or the search.'));
  }
  const calc = view.calc ?? {};
  table.append(
    h(
      'div',
      { class: 'db-row db-calc', role: 'row' },
      properties.map((prop) => {
        const name = calc[prop.id];
        const label = CALCULATIONS.find(([key]) => key === name)?.[1];
        const result = name ? calculate(name, rows, prop) : null;
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
    ),
  );

  return h('div', { class: 'db-scroll' }, table);
}
