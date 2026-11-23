// Board (Kanban) view of a database: cards in columns, one column per value
// of the property the view is grouped by.
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { openMenu } from '../../lib/menu.js';
import { promptDialog } from '../../lib/modal.js';
import { store } from '../store.js';
import { editValue, isEmpty, newId, optionPill, personChip, renderValue, valueOf } from './values.js';

const NONE = '__none__';

export function renderBoard(ctx) {
  const { view, rows, canEdit } = ctx;
  const group = view.groupBy ? ctx.property(view.groupBy) : null;
  if (!group) {
    return h(
      'div',
      { class: 'db-empty' },
      'A board needs a Select, Status or Person property to group its cards by. Add one from a table view, then choose it under “Group by”.',
    );
  }
  const byPerson = group.type === 'person';
  const columns = [
    { key: NONE, label: byPerson ? 'Unassigned' : `No ${group.name}`, color: 'default' },
    ...(byPerson
      ? [...store.users].map(([id]) => ({ key: String(id), person: id, color: 'default' }))
      : (group.options ?? []).map((option) => ({ key: option.id, option, color: option.color }))),
  ];
  const keysOf = (row) => {
    const value = valueOf(row, group);
    if (isEmpty(value)) return [NONE];
    return (Array.isArray(value) ? value : [value]).map(String);
  };
  /** The group value of a card moved from one column to another. */
  const valueFor = (row, from, to) => {
    if (!byPerson) return to === NONE ? null : to;
    const people = (valueOf(row, group) ?? []).filter((id) => String(id) !== from);
    if (to !== NONE && !people.includes(Number(to))) people.push(Number(to));
    return people.length ? people : null;
  };
  const cardProperties = ctx.properties.filter((prop) => prop.type !== 'title' && prop.id !== group.id);

  let dragged = null; // { row, from }
  const board = h('div', { class: 'db-board' });

  for (const column of columns) {
    const cards = rows.filter((row) => keysOf(row).includes(column.key));
    const list = h('div', { class: 'db-cards' });

    const clearDrop = () => list.querySelectorAll('[data-drop]').forEach((el) => delete el.dataset.drop);

    for (const row of cards) {
      const editable = canEdit && row.can_edit;
      const title = h('div', { class: `db-card-title${row.title ? '' : ' db-untitled'}` }, row.icon ? `${row.icon} ` : '', row.title || 'Untitled');
      const card = h(
        'div',
        { class: 'db-card', draggable: editable, tabIndex: 0, role: 'link', dataset: { row: row.id } },
        title,
        cardProperties.map((prop) => {
          const shown = renderValue(prop, valueOf(row, prop));
          // An unticked checkbox says nothing on a card.
          if (!shown || (prop.type === 'checkbox' && valueOf(row, prop) !== true)) return null;
          return h('div', { class: 'db-card-prop', title: prop.name }, shown);
        }),
      );
      const rename = () =>
        editValue({ id: 'title', name: 'Name', type: 'title' }, row.title, card, {
          onChange: (next) => ctx.updateRow(row, { title: next ?? '' }),
          onProperty: () => {},
        });
      if (editable) {
        const tools = h(
          'div',
          { class: 'db-card-tools' },
          h(
            'button',
            {
              class: 'db-card-tool',
              type: 'button',
              title: 'Rename',
              'aria-label': 'Rename',
              onclick: (event) => {
                event.stopPropagation();
                rename();
              },
            },
            icon('pencil', 13),
          ),
          h(
            'button',
            {
              class: 'db-card-tool',
              type: 'button',
              title: 'More',
              'aria-label': 'Card options',
              onclick: (event) => {
                event.stopPropagation();
                openMenu({
                  anchor: event.currentTarget,
                  items: [
                    { label: 'Open', icon: 'external', onSelect: () => ctx.openRow(row) },
                    { separator: true },
                    { label: 'Delete', icon: 'trash-2', danger: true, onSelect: () => ctx.deleteRow(row) },
                  ],
                });
              },
            },
            icon('more', 13),
          ),
        );
        card.append(tools);
        card.addEventListener('dragstart', (event) => {
          dragged = { row, from: column.key };
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', row.title || 'Untitled');
          setTimeout(() => card.classList.add('is-dragging'), 0);
        });
        card.addEventListener('dragend', () => {
          dragged = null;
          card.classList.remove('is-dragging');
          board.querySelectorAll('[data-drop]').forEach((el) => delete el.dataset.drop);
          board.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
        });
        if (ctx.editTitleOf === row.id) setTimeout(() => card.isConnected && rename(), 0);
      }
      card.addEventListener('click', (event) => ctx.openRow(row, event));
      card.addEventListener('auxclick', (event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        ctx.openRow(row, event);
      });
      card.addEventListener('mousedown', (event) => {
        if (event.button === 1) event.preventDefault();
      });
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && event.target === card) ctx.openRow(row);
      });
      list.append(card);
    }

    const element = h(
      'div',
      { class: 'db-column', dataset: { color: column.color, group: column.key } },
      h(
        'div',
        { class: 'db-column-head' },
        column.option
          ? optionPill(column.option, { status: group.type === 'status' })
          : column.person
            ? personChip(column.person)
            : h('span', { class: 'db-column-none' }, column.label),
        h('span', { class: 'db-column-count' }, String(cards.length)),
        canEdit
          ? h(
              'button',
              {
                class: 'db-card-tool db-column-add',
                type: 'button',
                title: 'Add a card',
                'aria-label': `Add a card to ${column.option?.name ?? column.label ?? 'this column'}`,
                onclick: () => addCard({ beforeId: cards[0]?.id ?? null }),
              },
              icon('plus', 14),
            )
          : null,
      ),
      list,
      canEdit
        ? h(
            'button',
            { class: 'db-add-card', type: 'button', onclick: () => addCard({ afterId: cards.at(-1)?.id ?? null }) },
            icon('plus', 14),
            'New page',
          )
        : null,
    );

    function addCard(place) {
      const value = column.key === NONE ? null : byPerson ? [Number(column.key)] : column.key;
      ctx.addRow({ props: value === null ? {} : { [group.id]: value }, ...place });
    }

    if (canEdit) {
      element.addEventListener('dragover', (event) => {
        if (!dragged) return;
        event.preventDefault();
        element.classList.add('is-drop-target');
        clearDrop();
        const over = event.target.closest?.('.db-card');
        if (over && list.contains(over) && Number(over.dataset.row) !== dragged.row.id) {
          const rect = over.getBoundingClientRect();
          over.dataset.drop = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        }
      });
      element.addEventListener('dragleave', (event) => {
        if (!element.contains(event.relatedTarget)) {
          element.classList.remove('is-drop-target');
          clearDrop();
        }
      });
      element.addEventListener('drop', async (event) => {
        event.preventDefault();
        if (!dragged) return;
        const { row, from } = dragged;
        dragged = null;
        const over = list.querySelector('[data-drop]');
        const place = over
          ? over.dataset.drop === 'before'
            ? { beforeId: Number(over.dataset.row) }
            : { afterId: Number(over.dataset.row) }
          : null;
        element.classList.remove('is-drop-target');
        clearDrop();
        if (from !== column.key) {
          await ctx.updateRow(row, { props: { [group.id]: valueFor(row, from, column.key) } });
        }
        // The order inside a column is the manual order of the rows.
        if (place && !ctx.sorted) ctx.moveRow(row, place);
        else if (!place && !ctx.sorted && cards.length && from !== column.key) {
          ctx.moveRow(row, { afterId: cards.at(-1).id });
        }
      });
    }
    board.append(element);
  }

  if (canEdit && !byPerson) {
    board.append(
      h(
        'button',
        {
          class: 'db-add-group',
          type: 'button',
          onclick: async () => {
            const name = await promptDialog({ title: `New ${group.name.toLowerCase()} group`, placeholder: 'Name', confirmLabel: 'Add' });
            if (!name) return;
            const colors = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
            const used = new Set((group.options ?? []).map((option) => option.color));
            const color = colors.find((item) => !used.has(item)) ?? colors[(group.options ?? []).length % colors.length];
            ctx.saveProperty({ ...group, options: [...(group.options ?? []), { id: newId('o'), name, color }] });
          },
        },
        icon('plus', 14),
        'Add a group',
      ),
    );
  }
  return h('div', { class: 'db-scroll' }, board);
}
