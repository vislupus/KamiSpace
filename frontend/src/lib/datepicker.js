// A small month calendar and text fields for dates and times, used wherever
// a date is chosen. Unlike the browser's own date input it always follows the
// same conventions: weeks start on Monday, dates read DD.MM.YYYY, times use
// the 24-hour clock, and public holidays are marked.
import {
  MONTHS,
  WEEKDAYS,
  addMonths,
  formatDate,
  holidaysOn,
  isWeekend,
  monthWeeks,
  now,
  parseDate,
  parseTime,
  parts,
} from './bgcalendar.js';
import { h } from './dom.js';
import { icon } from './icons.js';

/**
 * A month grid. `selected` is a date or a [from, to] pair.
 * Returns { el, show(date), select(selected) }.
 */
export function createMonthPicker({ selected = null, onPick }) {
  const today = now().date;
  let chosen = selected;
  let cursor = (Array.isArray(chosen) ? chosen[0] : chosen) ?? today;
  const title = h('span', { class: 'datepicker-title' });
  const grid = h('div', { class: 'datepicker-grid', role: 'grid' });
  const step = (count) => () => {
    cursor = addMonths(`${cursor.slice(0, 8)}01`, count);
    draw();
  };
  const el = h(
    'div',
    { class: 'datepicker' },
    h(
      'div',
      { class: 'datepicker-head' },
      title,
      h('button', { class: 'icon-button', type: 'button', title: 'Previous month', 'aria-label': 'Previous month', onclick: step(-1) }, icon('chevron-left', 15)),
      h('button', { class: 'icon-button', type: 'button', title: 'Next month', 'aria-label': 'Next month', onclick: step(1) }, icon('chevron-right', 15)),
    ),
    grid,
  );

  function inRange(day) {
    if (!chosen) return '';
    const [from, to] = Array.isArray(chosen) ? chosen : [chosen, chosen];
    if (day === from || day === to) return ' is-selected';
    return to && day > from && day < to ? ' is-between' : '';
  }

  function draw() {
    const { year, month } = parts(cursor);
    title.textContent = `${MONTHS[month - 1]} ${year}`;
    grid.replaceChildren(
      h('span', { class: 'datepicker-week', title: 'ISO week number' }, 'W'),
      ...WEEKDAYS.map((name, index) => h('span', { class: `datepicker-weekday${index >= 5 ? ' is-weekend' : ''}` }, name.slice(0, 2))),
      ...monthWeeks(year, month).flatMap((week) => [
        h('span', { class: 'datepicker-week' }, String(week.week)),
        ...week.days.map((day) => {
          const holiday = holidaysOn(day);
          const off = holiday.some((item) => item.off);
          return h(
            'button',
            {
              class:
                `datepicker-day${parts(day).month === month ? '' : ' is-outside'}${day === today ? ' is-today' : ''}` +
                `${isWeekend(day) ? ' is-weekend' : ''}${off ? ' is-holiday' : ''}${inRange(day)}`,
              type: 'button',
              title: holiday.length ? `${formatDate(day)} — ${holiday.map((item) => item.name).join(', ')}` : formatDate(day),
              'aria-label': formatDate(day),
              dataset: { date: day },
              onclick: () => onPick(day),
            },
            String(parts(day).day),
          );
        }),
      ]),
    );
  }
  draw();
  return {
    el,
    show(date) {
      if (!date) return;
      cursor = date;
      draw();
    },
    select(next) {
      chosen = next;
      draw();
    },
  };
}

/** A text field for a date, written and read as DD.MM.YYYY. onChange(date | null). */
export function dateInput({ value = null, label, onChange, onFocus }) {
  let current = value;
  const input = h('input', {
    class: 'input date-input',
    type: 'text',
    inputMode: 'numeric',
    placeholder: 'DD.MM.YYYY',
    value: value ? formatDate(value) : '',
    'aria-label': label,
    autocomplete: 'off',
    spellcheck: false,
  });
  const commit = () => {
    const text = input.value.trim();
    const parsed = text ? parseDate(text) : null;
    input.classList.toggle('is-invalid', Boolean(text) && !parsed);
    if (text && !parsed) return;
    input.value = parsed ? formatDate(parsed) : '';
    if (parsed !== current) {
      current = parsed;
      onChange(parsed);
    }
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    }
  });
  if (onFocus) input.addEventListener('focus', onFocus);
  return {
    el: input,
    get value() {
      return current;
    },
    set(next) {
      current = next;
      input.value = next ? formatDate(next) : '';
      input.classList.remove('is-invalid');
    },
  };
}

/** A text field for a time on the 24-hour clock (HH:MM). onChange(time | null). */
export function timeInput({ value = null, label, onChange }) {
  let current = value;
  const input = h('input', {
    class: 'input time-input',
    type: 'text',
    inputMode: 'numeric',
    placeholder: 'HH:MM',
    value: value ?? '',
    'aria-label': label,
    autocomplete: 'off',
    spellcheck: false,
    maxLength: 5,
  });
  const commit = () => {
    const text = input.value.trim();
    const parsed = text ? parseTime(text) : null;
    input.classList.toggle('is-invalid', Boolean(text) && !parsed);
    if (text && !parsed) return;
    input.value = parsed ?? '';
    if (parsed !== current) {
      current = parsed;
      onChange(parsed);
    }
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    }
  });
  return {
    el: input,
    get value() {
      return current;
    },
    set(next) {
      current = next;
      input.value = next ?? '';
      input.classList.remove('is-invalid');
    },
  };
}
