// Property types of a database: how a value is shown, edited, compared,
// filtered and summed up. Shared by the table, the board and the property
// list at the top of a row's page.
import { addDays, formatDateTime, parseTime } from '../../lib/bgcalendar.js';
import { createMonthPicker, dateInput, timeInput } from '../../lib/datepicker.js';
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { openMenu } from '../../lib/menu.js';
import { openPopover } from '../../lib/popover.js';
import { initials } from '../../lib/util.js';
import { store, userName } from '../store.js';

export const TYPES = {
  title: { label: 'Title', icon: 'text' },
  text: { label: 'Text', icon: 'align-left' },
  number: { label: 'Number', icon: 'hash' },
  select: { label: 'Select', icon: 'select' },
  multi_select: { label: 'Multi-select', icon: 'list' },
  status: { label: 'Status', icon: 'status' },
  date: { label: 'Date', icon: 'calendar' },
  person: { label: 'Person', icon: 'users' },
  checkbox: { label: 'Checkbox', icon: 'checkbox' },
  url: { label: 'URL', icon: 'link' },
};
/** Types offered when adding a property (a database has exactly one title). */
export const ADDABLE_TYPES = Object.keys(TYPES).filter((type) => type !== 'title');
export const COLORS = ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
export const NUMBER_FORMATS = [
  ['number', 'Number'],
  ['percent', 'Percent'],
  ['bar', 'Progress bar'],
];
const OPTION_TYPES = new Set(['select', 'multi_select', 'status']);

export function hasOptions(prop) {
  return OPTION_TYPES.has(prop.type);
}

export function newId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return prefix + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function nextColor(options) {
  const used = new Set(options.map((option) => option.color));
  return COLORS.slice(1).find((color) => !used.has(color)) ?? COLORS[1 + (options.length % 9)];
}

export function isEmpty(value) {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length);
}

/** "23.11.2026", or "23.11.2026 14:30" for a date with a time. */
export const formatDate = formatDateTime;

function formatNumber(value) {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

/** The value of a property for a row (the title lives on the row itself). */
export function valueOf(row, prop) {
  return prop.type === 'title' ? row.title : (row.props?.[prop.id] ?? null);
}

// -- showing ----------------------------------------------------------------------

export function optionPill(option, { status = false, onRemove = null } = {}) {
  return h(
    'span',
    { class: `db-pill${status ? ' is-status' : ''}`, dataset: { color: option.color || 'default' } },
    status ? h('span', { class: 'db-pill-dot' }) : null,
    h('span', { class: 'db-pill-text' }, option.name),
    onRemove
      ? h(
          'button',
          {
            class: 'db-pill-remove',
            type: 'button',
            'aria-label': `Remove ${option.name}`,
            onmousedown: (event) => event.preventDefault(),
            onclick: (event) => {
              event.stopPropagation();
              onRemove();
            },
          },
          icon('x', 11),
        )
      : null,
  );
}

export function personChip(userId) {
  const name = userName(userId) ?? 'Former member';
  return h(
    'span',
    { class: 'db-person' },
    h('span', { class: 'db-avatar', 'aria-hidden': 'true' }, initials(name)),
    h('span', { class: 'db-person-name' }, name),
  );
}

/** DOM for a value, or null when there is nothing to show. */
export function renderValue(prop, value) {
  if (isEmpty(value) && prop.type !== 'checkbox') return null;
  switch (prop.type) {
    case 'title':
    case 'text':
      return h('span', { class: 'db-text' }, value);
    case 'number': {
      if (prop.format === 'bar') {
        const percent = Math.max(0, Math.min(100, Number(value)));
        return h(
          'span',
          { class: 'db-progress' },
          h('span', { class: 'db-progress-number' }, `${formatNumber(value)}%`),
          h('span', { class: 'db-progress-track' }, h('span', { class: 'db-progress-fill', style: { width: `${percent}%` } })),
        );
      }
      return h('span', { class: 'db-number' }, prop.format === 'percent' ? `${formatNumber(value)}%` : formatNumber(value));
    }
    case 'select':
    case 'status': {
      const option = prop.options?.find((item) => item.id === value);
      return option ? optionPill(option, { status: prop.type === 'status' }) : null;
    }
    case 'multi_select': {
      const options = (value ?? []).map((id) => prop.options?.find((item) => item.id === id)).filter(Boolean);
      return options.length ? h('span', { class: 'db-pills' }, options.map((option) => optionPill(option))) : null;
    }
    case 'date':
      return h(
        'span',
        { class: 'db-date' },
        formatDate(value.start),
        value.end ? [' → ', formatDate(value.end)] : null,
      );
    case 'person':
      return h('span', { class: 'db-pills' }, value.map((id) => personChip(id)));
    case 'checkbox':
      return h('input', {
        type: 'checkbox',
        class: 'db-checkbox',
        checked: value === true,
        tabIndex: -1,
        'aria-label': prop.name,
      });
    case 'url':
      return h(
        'a',
        {
          class: 'db-url',
          href: value,
          target: '_blank',
          rel: 'noopener noreferrer nofollow',
          onclick: (event) => event.stopPropagation(),
        },
        value.replace(/^https?:\/\//, ''),
      );
    default:
      return null;
  }
}

// -- editing ----------------------------------------------------------------------

/** An input laid exactly over the cell, the way Notion edits text and numbers. */
function editInline(prop, value, anchor, onChange) {
  const multiline = prop.type === 'text';
  const input = h(multiline ? 'textarea' : 'input', {
    class: 'db-inline-input',
    type: multiline ? null : 'text',
    inputMode: prop.type === 'number' ? 'decimal' : null,
    rows: multiline ? 1 : null,
    value: value ?? '',
    placeholder: prop.type === 'url' ? 'https://…' : '',
    'aria-label': prop.name,
    spellcheck: prop.type === 'text',
  });
  let cancelled = false;
  const grow = () => {
    if (!multiline) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  };
  const rect = anchor.getBoundingClientRect();
  const popover = openPopover({
    anchor: () => new DOMRect(rect.left, rect.top - 6, rect.width, 0),
    placement: 'bottom-start',
    offset: 6,
    className: 'db-inline-popover',
    content: input,
    restoreFocus: false,
    onClose: () => {
      if (cancelled) return;
      let next = input.value.trim();
      if (prop.type === 'number') {
        const parsed = Number(next.replace(',', '.').replace(/%$/, ''));
        next = next === '' || Number.isNaN(parsed) ? null : parsed;
      } else if (prop.type === 'url' && next && !/^[a-z][a-z0-9+.-]*:|^\//i.test(next)) {
        next = `https://${next}`;
      }
      if ((next || null) !== (value ?? null)) onChange(next === '' ? null : next);
    },
  });
  popover.el.style.width = `${Math.max(rect.width, 200)}px`;
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelled = true;
      popover.close();
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      popover.close();
    }
  });
  grow();
  input.focus();
  input.select?.();
}

function editOptions(prop, value, anchor, { onChange, onProperty }) {
  const multi = prop.type === 'multi_select';
  let chosen = multi ? [...(value ?? [])] : value ? [value] : [];
  let options = prop.options ?? [];
  const search = h('input', {
    class: 'db-option-search',
    type: 'text',
    placeholder: 'Search for an option…',
    'aria-label': 'Search or create an option',
    autocomplete: 'off',
  });
  const chosenBox = h('div', { class: 'db-option-chosen' });
  const list = h('div', { class: 'db-option-list', role: 'listbox' });
  let active = 0;
  let visible = [];
  let renaming = null;

  const commit = () => onChange(multi ? (chosen.length ? chosen : null) : (chosen[0] ?? null));
  const saveOptions = (next) => {
    options = next;
    onProperty({ ...prop, options });
  };
  const pick = (option) => {
    if (multi) {
      chosen = chosen.includes(option.id) ? chosen.filter((id) => id !== option.id) : [...chosen, option.id];
      search.value = '';
      commit();
      render();
      search.focus();
    } else {
      chosen = [option.id];
      commit();
      popover.close();
    }
  };
  const create = () => {
    const name = search.value.trim();
    if (!name) return;
    const option = { id: newId('o'), name, color: nextColor(options) };
    saveOptions([...options, option]);
    pick(option);
  };
  const editOption = (option, button) => {
    openMenu({
      anchor: button,
      placement: 'right-start',
      items: [
        {
          label: 'Rename…',
          icon: 'pencil',
          onSelect: () => {
            renaming = option.id;
            render();
          },
        },
        {
          label: 'Delete',
          icon: 'trash-2',
          danger: true,
          onSelect: () => {
            saveOptions(options.filter((item) => item.id !== option.id));
            if (chosen.includes(option.id)) {
              chosen = chosen.filter((id) => id !== option.id);
              commit();
            }
            render();
          },
        },
        { separator: true },
        { heading: 'Colour' },
        ...COLORS.map((color) => ({
          label: color[0].toUpperCase() + color.slice(1),
          checked: option.color === color,
          onSelect: () => {
            saveOptions(options.map((item) => (item.id === option.id ? { ...item, color } : item)));
            render();
          },
        })),
      ],
    });
  };

  function render() {
    const status = prop.type === 'status';
    chosenBox.replaceChildren(
      ...chosen
        .map((id) => options.find((option) => option.id === id))
        .filter(Boolean)
        .map((option) =>
          optionPill(option, {
            status,
            onRemove: () => {
              chosen = chosen.filter((id) => id !== option.id);
              commit();
              render();
            },
          }),
        ),
      search,
    );
    const query = search.value.trim().toLowerCase();
    visible = options.filter((option) => !query || option.name.toLowerCase().includes(query));
    const exact = options.some((option) => option.name.toLowerCase() === query);
    const rows = visible.map((option, index) => {
      const more = h(
        'button',
        {
          class: 'db-option-more',
          type: 'button',
          'aria-label': `Edit ${option.name}`,
          onclick: (event) => {
            event.stopPropagation();
            editOption(option, more);
          },
        },
        icon('more', 14),
      );
      if (renaming === option.id) {
        const input = h('input', { class: 'input db-option-rename', type: 'text', value: option.name, 'aria-label': 'Option name' });
        const finish = (save) => {
          if (renaming !== option.id) return;
          renaming = null;
          const name = input.value.trim();
          if (save && name && name !== option.name) {
            saveOptions(options.map((item) => (item.id === option.id ? { ...item, name } : item)));
          }
          render();
        };
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            finish(event.key === 'Enter');
          }
        });
        input.addEventListener('blur', () => finish(true));
        setTimeout(() => {
          input.focus();
          input.select();
        }, 0);
        return h('div', { class: 'db-option' }, input);
      }
      return h(
        'div',
        {
          class: `db-option${index === active ? ' is-active' : ''}`,
          role: 'option',
          'aria-selected': chosen.includes(option.id) ? 'true' : 'false',
          onclick: () => pick(option),
        },
        optionPill(option, { status }),
        chosen.includes(option.id) ? icon('check', 14) : null,
        more,
      );
    });
    if (query && !exact) {
      rows.push(
        h(
          'div',
          {
            class: `db-option db-option-create${active >= visible.length ? ' is-active' : ''}`,
            role: 'option',
            onclick: create,
          },
          'Create ',
          optionPill({ name: search.value.trim(), color: nextColor(options) }, { status }),
        ),
      );
    }
    list.replaceChildren(
      h('div', { class: 'db-option-hint' }, options.length ? 'Select an option or create one' : 'Type a name to create an option'),
      ...rows,
    );
  }

  search.addEventListener('input', () => {
    active = 0;
    render();
    search.focus();
  });
  search.addEventListener('keydown', (event) => {
    const query = search.value.trim();
    const count = visible.length + (query && !options.some((o) => o.name.toLowerCase() === query.toLowerCase()) ? 1 : 0);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (count) active = (active + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
      render();
      search.focus();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (visible[active]) pick(visible[active]);
      else if (query) create();
    } else if (event.key === 'Backspace' && !search.value && chosen.length) {
      chosen = chosen.slice(0, -1);
      commit();
      render();
      search.focus();
    }
  });

  const popover = openPopover({
    anchor,
    placement: 'bottom-start',
    offset: 2,
    className: 'db-option-popover',
    content: h('div', { class: 'db-option-editor' }, chosenBox, list),
    restoreFocus: false,
  });
  render();
  search.focus();
}

function editDate(prop, value, anchor, onChange) {
  let current = value ? { ...value } : null;
  let withTime = Boolean(current?.start && current.start.length > 10);
  let withEnd = Boolean(current?.end);
  let active = 'start';
  const day = (moment) => (moment ? moment.slice(0, 10) : null);
  const clock = (moment) => (moment && moment.length > 10 ? moment.slice(11, 16) : null);
  const later = (time) => {
    const [hours, minutes] = time.split(':').map(Number);
    return hours >= 23 ? '23:59' : parseTime(`${hours + 1}:${String(minutes).padStart(2, '0')}`);
  };

  const apply = () => {
    let next = null;
    if (startDate.value) {
      const start = withTime ? `${startDate.value}T${startTime.value ?? '09:00'}` : startDate.value;
      next = { start };
      if (withEnd && endDate.value) {
        const end = withTime ? `${endDate.value}T${endTime.value ?? later(start.slice(11))}` : endDate.value;
        if (end > start) next.end = end;
      }
    }
    picker.select(next ? [day(next.start), day(next.end) ?? day(next.start)] : null);
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      current = next;
      onChange(next);
    }
  };

  const startDate = dateInput({ value: day(current?.start), label: 'Start date', onChange: apply, onFocus: () => (active = 'start') });
  const endDate = dateInput({ value: day(current?.end), label: 'End date', onChange: apply, onFocus: () => (active = 'end') });
  const startTime = timeInput({ value: clock(current?.start), label: 'Start time', onChange: apply });
  const endTime = timeInput({ value: clock(current?.end), label: 'End time', onChange: apply });
  const endRow = h('div', { class: 'db-date-fields' }, endDate.el, endTime.el);
  const picker = createMonthPicker({
    selected: current ? [day(current.start), day(current.end) ?? day(current.start)] : null,
    onPick: (picked) => {
      if (active === 'end' && withEnd && startDate.value && picked >= startDate.value) {
        endDate.set(picked);
      } else {
        // Moving the start keeps the length of a range.
        if (withEnd && endDate.value && startDate.value) {
          const length = Math.round((Date.parse(endDate.value) - Date.parse(startDate.value)) / 86_400_000);
          endDate.set(addDays(picked, Math.max(length, 0)));
        }
        startDate.set(picked);
        if (withEnd) active = 'end';
      }
      apply();
    },
  });
  const hasEnd = h('input', { type: 'checkbox', checked: withEnd });
  const hasTime = h('input', { type: 'checkbox', checked: withTime });
  const layout = () => {
    endRow.hidden = !withEnd;
    startTime.el.hidden = !withTime;
    endTime.el.hidden = !withTime;
  };
  hasEnd.addEventListener('change', () => {
    withEnd = hasEnd.checked;
    if (withEnd && !endDate.value && startDate.value) {
      endDate.set(withTime ? startDate.value : addDays(startDate.value, 1));
      if (withTime) endTime.set(later(startTime.value ?? '09:00'));
    }
    active = withEnd ? 'end' : 'start';
    layout();
    apply();
  });
  hasTime.addEventListener('change', () => {
    withTime = hasTime.checked;
    if (withTime && !startTime.value) {
      startTime.set('09:00');
      if (withEnd) endTime.set('10:00');
    }
    layout();
    apply();
  });
  layout();
  const popover = openPopover({
    anchor,
    placement: 'bottom-start',
    offset: 2,
    className: 'db-date-popover',
    restoreFocus: false,
    content: h(
      'div',
      { class: 'db-date-editor' },
      h('div', { class: 'db-date-fields' }, startDate.el, startTime.el),
      endRow,
      picker.el,
      h('label', { class: 'checkbox' }, hasEnd, 'End date'),
      h('label', { class: 'checkbox' }, hasTime, 'Include time'),
      h(
        'div',
        { class: 'due-shortcuts' },
        h(
          'button',
          {
            class: 'button button-small',
            type: 'button',
            onclick: () => {
              startDate.set(null);
              endDate.set(null);
              apply();
              popover.close();
            },
          },
          'Clear',
        ),
      ),
    ),
  });
  startDate.el.focus();
}

function editPeople(prop, value, anchor, onChange) {
  let chosen = [...(value ?? [])];
  const list = h('div', { class: 'db-option-list' });
  const render = () => {
    list.replaceChildren(
      h('div', { class: 'db-option-hint' }, 'Select one or more people'),
      ...[...store.users].map(([id]) =>
        h(
          'div',
          {
            class: 'db-option',
            role: 'option',
            'aria-selected': chosen.includes(id) ? 'true' : 'false',
            onclick: () => {
              chosen = chosen.includes(id) ? chosen.filter((item) => item !== id) : [...chosen, id];
              onChange(chosen.length ? chosen : null);
              render();
            },
          },
          personChip(id),
          chosen.includes(id) ? icon('check', 14) : null,
        ),
      ),
    );
  };
  render();
  openPopover({
    anchor,
    placement: 'bottom-start',
    offset: 2,
    className: 'db-option-popover',
    content: h('div', { class: 'db-option-editor' }, list),
    restoreFocus: false,
  });
}

/**
 * Open the editor that fits the property.
 * onChange(value) stores the value; onProperty(prop) stores a changed
 * property (new or edited options).
 */
export function editValue(prop, value, anchor, { onChange, onProperty }) {
  switch (prop.type) {
    case 'checkbox':
      onChange(value === true ? null : true);
      break;
    case 'select':
    case 'status':
    case 'multi_select':
      editOptions(prop, value, anchor, { onChange, onProperty });
      break;
    case 'date':
      editDate(prop, value, anchor, onChange);
      break;
    case 'person':
      editPeople(prop, value, anchor, onChange);
      break;
    default:
      editInline(prop, value, anchor, onChange);
  }
}

// -- sorting, filtering, summing up ------------------------------------------------

function sortKey(prop, value) {
  if (isEmpty(value)) return null;
  switch (prop.type) {
    case 'number':
      return Number(value);
    case 'select':
    case 'status': {
      const index = prop.options?.findIndex((option) => option.id === value) ?? -1;
      return index < 0 ? null : index;
    }
    case 'multi_select':
      return value.map((id) => prop.options?.find((option) => option.id === id)?.name ?? '').join(', ').toLowerCase();
    case 'date':
      return value.start;
    case 'person':
      return value.map((id) => userName(id) ?? '').join(', ').toLowerCase();
    case 'checkbox':
      return value === true ? 1 : 0;
    default:
      return String(value).toLowerCase();
  }
}

export function compareRows(a, b, prop, direction) {
  const left = sortKey(prop, valueOf(a, prop));
  const right = sortKey(prop, valueOf(b, prop));
  if (left === right) return 0;
  // Empty values go last, whichever way the sort runs.
  if (left === null) return 1;
  if (right === null) return -1;
  const order = typeof left === 'number' ? left - right : String(left).localeCompare(String(right));
  return direction === 'desc' ? -order : order;
}

/** Text of a value, for search and "contains" filters. */
export function textOf(prop, value) {
  if (isEmpty(value)) return '';
  switch (prop.type) {
    case 'select':
    case 'status':
      return prop.options?.find((option) => option.id === value)?.name ?? '';
    case 'multi_select':
      return value.map((id) => prop.options?.find((option) => option.id === id)?.name ?? '').join(' ');
    case 'person':
      return value.map((id) => userName(id) ?? '').join(' ');
    case 'date':
      return [value.start, value.end].filter(Boolean).join(' ');
    case 'checkbox':
      return '';
    default:
      return String(value);
  }
}

/** Filter operators that make sense for a property type: [op, label, needsValue]. */
export function filterOps(prop) {
  switch (prop.type) {
    case 'checkbox':
      return [
        ['checked', 'Is checked', false],
        ['unchecked', 'Is not checked', false],
      ];
    case 'number':
      return [
        ['is', '=', true],
        ['is_not', '≠', true],
        ['gt', '>', true],
        ['lt', '<', true],
        ['empty', 'Is empty', false],
        ['not_empty', 'Is not empty', false],
      ];
    case 'date':
      return [
        ['is', 'Is', true],
        ['before', 'Is before', true],
        ['after', 'Is after', true],
        ['empty', 'Is empty', false],
        ['not_empty', 'Is not empty', false],
      ];
    case 'select':
    case 'status':
    case 'multi_select':
    case 'person':
      return [
        ['is', prop.type === 'multi_select' || prop.type === 'person' ? 'Contains' : 'Is', true],
        ['is_not', prop.type === 'multi_select' || prop.type === 'person' ? 'Does not contain' : 'Is not', true],
        ['empty', 'Is empty', false],
        ['not_empty', 'Is not empty', false],
      ];
    default:
      return [
        ['contains', 'Contains', true],
        ['not_contains', 'Does not contain', true],
        ['is', 'Is', true],
        ['empty', 'Is empty', false],
        ['not_empty', 'Is not empty', false],
      ];
  }
}

export function matchesFilter(row, prop, rule) {
  const value = valueOf(row, prop);
  const wanted = rule.value;
  switch (rule.op) {
    case 'empty':
      return isEmpty(value);
    case 'not_empty':
      return !isEmpty(value);
    case 'checked':
      return value === true;
    case 'unchecked':
      return value !== true;
    default:
  }
  // A rule without a value does not filter yet (it is still being set up).
  if (isEmpty(wanted)) return true;
  const list = Array.isArray(value) ? value.map(String) : isEmpty(value) ? [] : [String(value)];
  switch (prop.type) {
    case 'select':
    case 'status':
    case 'multi_select':
    case 'person': {
      const has = list.includes(String(wanted));
      return rule.op === 'is_not' ? !has : has;
    }
    case 'number': {
      if (isEmpty(value)) return false;
      const number = Number(value);
      const target = Number(wanted);
      if (rule.op === 'gt') return number > target;
      if (rule.op === 'lt') return number < target;
      return rule.op === 'is_not' ? number !== target : number === target;
    }
    case 'date': {
      if (isEmpty(value)) return false;
      const day = value.start.slice(0, 10);
      if (rule.op === 'before') return day < wanted;
      if (rule.op === 'after') return day > wanted;
      return day === wanted;
    }
    default: {
      const text = textOf(prop, value).toLowerCase();
      const needle = String(wanted).toLowerCase();
      if (rule.op === 'is') return text === needle;
      return rule.op === 'not_contains' ? !text.includes(needle) : text.includes(needle);
    }
  }
}

export const CALCULATIONS = [
  ['count', 'Count all'],
  ['values', 'Count values'],
  ['empty', 'Count empty'],
  ['sum', 'Sum'],
  ['average', 'Average'],
  ['min', 'Min'],
  ['max', 'Max'],
];

export function calculate(name, rows, prop) {
  const values = rows.map((row) => valueOf(row, prop));
  const filled = values.filter((value) => !isEmpty(value));
  if (name === 'count') return rows.length;
  if (name === 'values') return filled.length;
  if (name === 'empty') return rows.length - filled.length;
  const numbers = filled.map(Number).filter((value) => Number.isFinite(value));
  if (!numbers.length) return null;
  const sum = numbers.reduce((total, value) => total + value, 0);
  if (name === 'sum') return formatNumber(Math.round(sum * 1e6) / 1e6);
  if (name === 'average') return formatNumber(Math.round((sum / numbers.length) * 100) / 100);
  if (name === 'min') return formatNumber(Math.min(...numbers));
  if (name === 'max') return formatNumber(Math.max(...numbers));
  return null;
}
