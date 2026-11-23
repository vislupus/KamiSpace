// The calendar: year, month, week and day views of everything that has a
// date — rows of the databases the user can see and tasks that are due —
// together with the official holidays of Bulgaria. Nothing is fetched from
// outside the installation; holidays are calculated (see lib/bgcalendar.js).
import { api } from '../lib/api.js';
import {
  MONTHS,
  TIME_ZONE,
  WEEKDAYS,
  WEEKDAYS_LONG,
  addDays,
  addMonths,
  clockChanges,
  daysBetween,
  formatDate,
  formatDayMonth,
  formatRange,
  holidays,
  holidaysOn,
  hoursInDay,
  isValidDate,
  isWeekend,
  isoDate,
  isoWeek,
  monthWeeks,
  now,
  offsetAt,
  parts,
  startOfWeek,
  weekday,
} from '../lib/bgcalendar.js';
import { dateInput, timeInput } from '../lib/datepicker.js';
import { h, replace } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { isModalOpen, openModal } from '../lib/modal.js';
import { hasOpenPopover } from '../lib/popover.js';
import { toast, toastError } from '../lib/toast.js';
import { storageGet, storageSet } from '../lib/util.js';
import { pagePath } from './router.js';
import { personalWorkspace, refreshTree } from './store.js';

const VIEWS = [
  ['year', 'Year', 'KeyY'],
  ['month', 'Month', 'KeyM'],
  ['week', 'Week', 'KeyW'],
  ['day', 'Day', 'KeyD'],
];
const HOUR = 48; // pixels per hour in the week and day views
const VIEW_KEY = 'kamispace-calendar-view';

const pad = (value) => String(value).padStart(2, '0');
const dayOf = (moment) => moment.slice(0, 10);
const timeOf = (moment) => (moment.length > 10 ? moment.slice(11, 16) : null);
const minutesOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const clock = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/** Does the item take place (at least partly) on this day? */
function onDay(item, day) {
  return dayOf(item.start) <= day && dayOf(item.end ?? item.start) >= day;
}

export function mountCalendar({ container, topbar }) {
  document.title = 'Calendar · KamiSpace';
  replace(topbar, h('nav', { class: 'breadcrumbs' }, h('span', { class: 'crumb' }, 'Calendar')));

  const query = new URLSearchParams(location.search);
  let view = VIEWS.some(([name]) => name === query.get('view')) ? query.get('view') : storageGet(VIEW_KEY, 'month');
  let cursor = isValidDate(query.get('date')) ? query.get('date') : now().date;
  let items = [];
  let sources = [];
  let loaded = null; // "start|end" of the data on screen
  let destroyed = false;
  let request = 0;

  const header = h('div', { class: 'cal-head' });
  const body = h('div', { class: 'cal-body' });
  const root = h('div', { class: 'cal' }, header, body);
  replace(container, root);

  // -- what is shown ---------------------------------------------------------------

  function range() {
    const { year, month } = parts(cursor);
    if (view === 'year') return [isoDate(year, 1, 1), isoDate(year, 12, 31)];
    if (view === 'month') {
      const weeks = monthWeeks(year, month);
      return [weeks[0].days[0], weeks.at(-1).days[6]];
    }
    if (view === 'week') return [startOfWeek(cursor), addDays(startOfWeek(cursor), 6)];
    return [cursor, cursor];
  }

  function title() {
    const { year, month } = parts(cursor);
    const week = isoWeek(cursor);
    if (view === 'year') return String(year);
    if (view === 'month') return `${MONTHS[month - 1]} ${year}`;
    if (view === 'week') {
      const monday = startOfWeek(cursor);
      return `Week ${week.week} · ${formatRange(monday, addDays(monday, 6))}`;
    }
    return `${WEEKDAYS_LONG[weekday(cursor) - 1]}, ${formatDate(cursor)} · Week ${week.week}`;
  }

  function move(direction) {
    if (view === 'year') cursor = addMonths(cursor, 12 * direction);
    else if (view === 'month') cursor = addMonths(`${cursor.slice(0, 8)}01`, direction);
    else cursor = addDays(cursor, (view === 'week' ? 7 : 1) * direction);
    show();
  }

  function go(nextView, date = cursor) {
    view = nextView;
    cursor = date;
    storageSet(VIEW_KEY, view);
    show();
  }

  async function load({ force = false } = {}) {
    const [start, end] = range();
    const key = `${start}|${end}`;
    if (!force && key === loaded) return;
    const current = ++request;
    try {
      const data = await api.get(`/api/calendar?start=${start}&end=${end}`);
      if (destroyed || current !== request) return;
      items = data.items;
      sources = data.databases;
      loaded = key;
      render();
    } catch (error) {
      if (!destroyed) toastError(error, 'Could not load the calendar');
    }
  }

  function show() {
    history.replaceState(null, '', `/calendar?view=${view}&date=${cursor}`);
    const [start, end] = range();
    // Items of another range would be wrong; holidays need no data at all.
    if (`${start}|${end}` !== loaded) items = [];
    render();
    load();
  }

  // -- events -----------------------------------------------------------------------

  function chip(item, day, { compact = false } = {}) {
    const time = timeOf(item.start);
    const startsHere = dayOf(item.start) === day;
    const label = item.title || 'Untitled';
    const isTask = item.kind === 'task';
    const linked = item.id !== null && item.id !== undefined;
    const el = h(
      linked ? 'a' : 'span',
      {
        class: `cal-chip${isTask ? ' is-task' : ''}${item.checked ? ' is-done' : ''}${startsHere ? '' : ' is-continued'}`,
        href: linked ? pagePath(item.id) : null,
        dataset: { ...(linked ? { link: '', id: item.id } : {}), color: item.color ?? 'default' },
        draggable: !isTask && item.can_edit,
        title: [
          label,
          item.end ? `${formatMoment(item.start)} → ${formatMoment(item.end)}` : formatMoment(item.start),
          isTask ? (item.page_title ? `Task in “${item.page_title}”` : 'Task') : `${item.database_title || 'Database'} · ${item.property}`,
        ].join('\n'),
      },
      isTask ? icon(item.checked ? 'check-circle' : 'tasks', 12) : null,
      time && startsHere && !compact ? h('span', { class: 'cal-chip-time' }, time) : null,
      h('span', { class: 'cal-chip-title' }, label),
    );
    if (!isTask && item.can_edit) {
      el.addEventListener('dragstart', (event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-kamispace-event', JSON.stringify({ id: item.id, property: item.property_id, from: day }));
        event.dataTransfer.setData('text/plain', label);
      });
    }
    return el;
  }

  function formatMoment(moment) {
    return moment.length > 10 ? `${formatDate(moment)} ${moment.slice(11, 16)}` : formatDate(moment);
  }

  /** Move an event by whole days (dragging a chip to another day). */
  async function moveItem(id, propertyId, fromDay, toDay) {
    const item = items.find((entry) => entry.kind === 'row' && entry.id === id && entry.property_id === propertyId);
    const shift = daysBetween(fromDay, toDay);
    if (!item || !shift) return;
    const moved = (moment) => addDays(dayOf(moment), shift) + moment.slice(10);
    const value = { start: moved(item.start), ...(item.end ? { end: moved(item.end) } : {}) };
    Object.assign(item, { start: value.start, end: value.end ?? null });
    render();
    try {
      await api.patch(`/api/databases/${item.database_id}/rows/${id}`, { props: { [propertyId]: value } });
    } catch (error) {
      toastError(error, 'Could not move the event');
    }
    load({ force: true });
  }

  function acceptDrops(el, day) {
    el.addEventListener('dragover', (event) => {
      if (!event.dataTransfer.types.includes('application/x-kamispace-event')) return;
      event.preventDefault();
      el.classList.add('is-drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('is-drop-target'));
    el.addEventListener('drop', (event) => {
      el.classList.remove('is-drop-target');
      const raw = event.dataTransfer.getData('application/x-kamispace-event');
      if (!raw) return;
      event.preventDefault();
      const dropped = JSON.parse(raw);
      moveItem(dropped.id, dropped.property, dropped.from, day);
    });
  }

  // -- new event --------------------------------------------------------------------

  async function createEventsDatabase() {
    const workspace = personalWorkspace();
    if (!workspace) return;
    try {
      await api.post('/api/databases', { workspace_id: workspace.id, title: 'Events', view: 'table' });
      await refreshTree();
      await load({ force: true });
      toast('“Events” database created', { type: 'success', duration: 2500 });
    } catch (error) {
      toastError(error, 'Could not create the database');
    }
  }

  function newEvent(day, time = null) {
    const targets = sources
      .filter((source) => source.can_edit)
      .flatMap((source) =>
        source.date_properties.map((property) => ({
          source,
          property,
          label: source.date_properties.length > 1 ? `${source.title || 'Untitled'} · ${property.name}` : source.title || 'Untitled',
        })),
      );
    if (!targets.length) {
      const modal = openModal({
        title: 'New event',
        content: h(
          'div',
          { class: 'form' },
          h(
            'p',
            { class: 'muted', style: 'margin: 0' },
            'Events are rows of a database with a Date property. Create a database for them, or add a Date property to one of yours — everything with a date then shows up here.',
          ),
          h(
            'div',
            { class: 'modal-actions' },
            h('button', { class: 'button', type: 'button', onclick: () => modal.close() }, 'Cancel'),
            h(
              'button',
              {
                class: 'button button-primary',
                type: 'button',
                onclick: async () => {
                  modal.close();
                  await createEventsDatabase();
                  if (sources.some((source) => source.can_edit)) newEvent(day, time);
                },
              },
              'Create an “Events” database',
            ),
          ),
        ),
      });
      return;
    }

    let allDay = time === null;
    const name = h('input', { class: 'input', type: 'text', placeholder: 'Event name', 'aria-label': 'Event name', maxLength: 300 });
    const target = h(
      'select',
      { class: 'select', 'aria-label': 'Database', style: 'width: 100%' },
      targets.map((entry, index) => h('option', { value: index }, entry.label)),
    );
    const remembered = storageGet('kamispace-calendar-target', null);
    const rememberedIndex = targets.findIndex((entry) => `${entry.source.id}:${entry.property.id}` === remembered);
    if (rememberedIndex >= 0) target.value = String(rememberedIndex);
    const startDate = dateInput({ value: day, label: 'Start date', onChange: () => {} });
    const endDate = dateInput({ value: null, label: 'End date', onChange: () => {} });
    const startTime = timeInput({ value: time ?? '09:00', label: 'Start time', onChange: () => {} });
    const endTime = timeInput({ value: clock(Math.min(minutesOf(time ?? '09:00') + 60, 23 * 60 + 59)), label: 'End time', onChange: () => {} });
    const wholeDay = h('input', { type: 'checkbox', checked: allDay });
    const layout = () => {
      startTime.el.hidden = allDay;
      endTime.el.hidden = allDay;
    };
    wholeDay.addEventListener('change', () => {
      allDay = wholeDay.checked;
      layout();
    });
    layout();
    const error = h('div', { class: 'link-error' });

    const form = h(
      'form',
      {
        class: 'form cal-form',
        onsubmit: async (event) => {
          event.preventDefault();
          const chosen = targets[Number(target.value)];
          const first = startDate.value;
          if (!first) {
            error.textContent = 'Enter a start date (DD.MM.YYYY)';
            return;
          }
          const last = endDate.value ?? first;
          let value;
          if (allDay) {
            value = { start: first, ...(last > first ? { end: last } : {}) };
          } else {
            if (!startTime.value) {
              error.textContent = 'Enter a start time (HH:MM, 24-hour clock)';
              return;
            }
            const start = `${first}T${startTime.value}`;
            const end = endTime.value ? `${last}T${endTime.value}` : null;
            if (end && end <= start) {
              error.textContent = 'The end must be after the start';
              return;
            }
            value = { start, ...(end ? { end } : {}) };
          }
          try {
            await api.post(`/api/databases/${chosen.source.id}/rows`, {
              title: name.value.trim(),
              props: { [chosen.property.id]: value },
            });
            storageSet('kamispace-calendar-target', `${chosen.source.id}:${chosen.property.id}`);
            modal.close();
            refreshTree();
            load({ force: true });
          } catch (problem) {
            error.textContent = problem.message || 'Could not create the event';
          }
        },
      },
      name,
      h('label', { class: 'field-label' }, 'In database'),
      target,
      h('label', { class: 'checkbox' }, wholeDay, 'All day'),
      h('div', { class: 'cal-form-row' }, h('span', null, 'Starts'), startDate.el, startTime.el),
      h('div', { class: 'cal-form-row' }, h('span', null, 'Ends'), endDate.el, endTime.el),
      error,
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { class: 'button', type: 'button', onclick: () => modal.close() }, 'Cancel'),
        h('button', { class: 'button button-primary', type: 'submit' }, 'Create'),
      ),
    );
    const modal = openModal({ title: 'New event', content: form });
    name.focus();
  }

  // -- header -------------------------------------------------------------------------

  function renderHeader() {
    const offset = offsetAt(Date.now());
    replace(
      header,
      h(
        'div',
        { class: 'cal-nav' },
        h('button', { class: 'button button-small', type: 'button', title: 'Today (T)', onclick: () => go(view, now().date) }, 'Today'),
        h('button', { class: 'icon-button', type: 'button', title: 'Previous (←)', 'aria-label': 'Previous', onclick: () => move(-1) }, icon('chevron-left', 16)),
        h('button', { class: 'icon-button', type: 'button', title: 'Next (→)', 'aria-label': 'Next', onclick: () => move(1) }, icon('chevron-right', 16)),
        h('h1', { class: 'cal-title' }, title()),
      ),
      h(
        'div',
        { class: 'cal-tools' },
        h('span', { class: 'cal-zone', title: `All times are shown for ${TIME_ZONE}` }, `${TIME_ZONE} · UTC+${offset / 60}`),
        h(
          'div',
          { class: 'segmented', role: 'tablist', 'aria-label': 'Calendar view' },
          VIEWS.map(([name, label, code]) =>
            h(
              'button',
              {
                class: `segment${name === view ? ' is-active' : ''}`,
                type: 'button',
                role: 'tab',
                'aria-selected': name === view ? 'true' : 'false',
                title: `${label} (${code.slice(3)})`,
                onclick: () => go(name),
              },
              label,
            ),
          ),
        ),
        h('button', { class: 'button button-primary button-small', type: 'button', onclick: () => newEvent(cursor) }, 'New event'),
      ),
    );
  }

  // -- year ---------------------------------------------------------------------------

  function dayClasses(day, month) {
    const special = holidaysOn(day);
    return (
      `${parts(day).month === month ? '' : ' is-outside'}${day === now().date ? ' is-today' : ''}` +
      `${isWeekend(day) ? ' is-weekend' : ''}` +
      `${special.some((item) => item.off && item.kind !== 'compensation') ? ' is-holiday' : ''}` +
      `${special.some((item) => item.kind === 'compensation') ? ' is-lieu' : ''}` +
      `${special.some((item) => item.kind === 'school') ? ' is-school' : ''}`
    );
  }

  function dayTitle(day) {
    const names = holidaysOn(day).map((item) => `${item.name} — ${item.nameEn}`);
    const count = items.filter((item) => onDay(item, day)).length;
    return [`${WEEKDAYS_LONG[weekday(day) - 1]}, ${formatDate(day)}`, ...names, count ? `${count} event${count === 1 ? '' : 's'}` : null]
      .filter(Boolean)
      .join('\n');
  }

  function renderYear() {
    const { year } = parts(cursor);
    const months = MONTHS.map((name, index) => {
      const month = index + 1;
      return h(
        'section',
        { class: 'cal-mini', 'aria-label': `${name} ${year}` },
        h('button', { class: 'cal-mini-title', type: 'button', onclick: () => go('month', isoDate(year, month, 1)) }, name),
        h(
          'div',
          { class: 'cal-mini-grid' },
          h('span', { class: 'cal-mini-week', title: 'ISO week number' }, 'W'),
          WEEKDAYS.map((weekdayName, position) =>
            h('span', { class: `cal-mini-weekday${position >= 5 ? ' is-weekend' : ''}` }, weekdayName.slice(0, 2)),
          ),
          monthWeeks(year, month).flatMap((week) => [
            h(
              'button',
              {
                class: 'cal-mini-week',
                type: 'button',
                title: `Week ${week.week} of ${week.year}`,
                onclick: () => go('week', week.days[0]),
              },
              String(week.week),
            ),
            ...week.days.map((day) =>
              // Days of the neighbouring months are left empty, so every date appears once.
              parts(day).month === month
                ? h(
                    'button',
                    {
                      class: `cal-mini-day${dayClasses(day, month)}${items.some((item) => onDay(item, day)) ? ' has-events' : ''}`,
                      type: 'button',
                      title: dayTitle(day),
                      dataset: { date: day },
                      onclick: () => go('day', day),
                    },
                    String(parts(day).day),
                  )
                : h('span'),
            ),
          ]),
        ),
      );
    });
    const { forward, back } = clockChanges(year);
    const list = holidays(year);
    return h(
      'div',
      { class: 'cal-year' },
      h('div', { class: 'cal-year-grid' }, months),
      h(
        'section',
        { class: 'cal-holidays' },
        h('h2', null, `Official holidays ${year}`),
        h(
          'div',
          { class: 'cal-legend' },
          h('span', { class: 'cal-key is-holiday' }, 'Holiday'),
          h('span', { class: 'cal-key is-lieu' }, 'Day off in lieu of a holiday on a weekend'),
          h('span', { class: 'cal-key is-school' }, 'No classes (a working day)'),
        ),
        h(
          'table',
          { class: 'cal-holiday-table' },
          h(
            'tbody',
            null,
            list.map((item) =>
              h(
                'tr',
                { class: `is-${item.kind}` },
                h('td', null, h('button', { class: 'cal-link', type: 'button', onclick: () => go('day', item.date) }, formatDate(item.date))),
                h('td', null, WEEKDAYS_LONG[weekday(item.date) - 1]),
                h('td', null, item.name),
                h('td', { class: 'muted' }, item.nameEn),
              ),
            ),
          ),
        ),
        h(
          'p',
          { class: 'muted cal-note' },
          `Clocks go forward on ${formatDate(forward)} (03:00 → 04:00) and back on ${formatDate(back)} (04:00 → 03:00). `,
          `${year} has ${isoWeek(isoDate(year, 12, 28)).week} ISO weeks. `,
          'Holidays follow the Labour Code (art. 154); days off that the government adds for a single year cannot be calculated and are not shown.',
        ),
      ),
    );
  }

  // -- month --------------------------------------------------------------------------

  function renderMonth() {
    const { year, month } = parts(cursor);
    const weeks = monthWeeks(year, month);
    const maxChips = weeks.length > 5 ? 3 : 4;
    return h(
      'div',
      { class: 'cal-month', style: `--weeks: ${weeks.length}` },
      h(
        'div',
        { class: 'cal-month-head' },
        h('span', { class: 'cal-week-number', title: 'ISO week number' }, 'W'),
        WEEKDAYS_LONG.map((name, index) => h('span', { class: `cal-weekday${index >= 5 ? ' is-weekend' : ''}` }, name)),
      ),
      weeks.map((week) =>
        h(
          'div',
          { class: 'cal-week-row' },
          h(
            'button',
            { class: 'cal-week-number', type: 'button', title: `Week ${week.week} of ${week.year}`, onclick: () => go('week', week.days[0]) },
            String(week.week),
          ),
          week.days.map((day) => {
            const todays = items.filter((item) => onDay(item, day));
            const special = holidaysOn(day);
            const cell = h(
              'div',
              { class: `cal-day${dayClasses(day, month)}`, dataset: { date: day } },
              h(
                'div',
                { class: 'cal-day-head' },
                h(
                  'button',
                  { class: 'cal-day-number', type: 'button', title: dayTitle(day), onclick: () => go('day', day) },
                  parts(day).day === 1 ? formatDayMonth(day) : String(parts(day).day),
                ),
                special.length
                  ? h('span', { class: 'cal-day-holiday', title: special.map((item) => `${item.name} — ${item.nameEn}`).join('\n') }, special.map((item) => item.name).join(' · '))
                  : null,
              ),
              todays.slice(0, maxChips).map((item) => chip(item, day)),
              todays.length > maxChips
                ? h('button', { class: 'cal-more', type: 'button', onclick: () => go('day', day) }, `+${todays.length - maxChips} more`)
                : null,
            );
            cell.addEventListener('click', (event) => {
              if (event.target === cell || event.target.classList.contains('cal-day-head')) newEvent(day);
            });
            acceptDrops(cell, day);
            return cell;
          }),
        ),
      ),
    );
  }

  // -- week and day ---------------------------------------------------------------------

  /** Side-by-side columns for events that overlap in time. */
  function arrange(events) {
    const sorted = [...events].sort((a, b) => a.from - b.from || b.to - a.to);
    const columns = [];
    let group = [];
    let groupEnd = -1;
    const close = () => {
      for (const event of group) event.columns = columns.length;
      columns.length = 0;
      group = [];
    };
    for (const event of sorted) {
      if (group.length && event.from >= groupEnd) close();
      let index = columns.findIndex((end) => end <= event.from);
      if (index < 0) index = columns.push(0) - 1;
      columns[index] = event.to;
      event.column = index;
      group.push(event);
      groupEnd = Math.max(groupEnd, event.to);
    }
    close();
    return sorted;
  }

  function renderTimeGrid(days) {
    const today = now();
    const hours = Array.from({ length: 24 }, (_, hour) => hour);
    const columns = days.map((day) => {
      const todays = items.filter((item) => onDay(item, day));
      const timed = todays.filter((item) => timeOf(item.start));
      const allDay = todays.filter((item) => !timeOf(item.start));
      const special = holidaysOn(day);
      const length = hoursInDay(day);

      const blocks = arrange(
        timed.map((item) => {
          // An event that runs past midnight is cut at the edges of the day.
          const from = dayOf(item.start) === day ? minutesOf(timeOf(item.start)) : 0;
          const ends = item.end ?? item.start;
          let to = dayOf(ends) === day ? minutesOf(timeOf(ends) ?? '23:59') : 24 * 60;
          if (to <= from) to = Math.min(from + 30, 24 * 60);
          return { item, from, to: Math.max(to, from + 30) };
        }),
      );

      const grid = h(
        'div',
        { class: `cal-grid-day${isWeekend(day) ? ' is-weekend' : ''}${special.some((item) => item.off) ? ' is-holiday' : ''}`, dataset: { date: day } },
        length !== 24
          ? h(
              'div',
              {
                class: `cal-dst${length === 23 ? ' is-skipped' : ' is-repeated'}`,
                style: `top: ${3 * HOUR}px; height: ${HOUR}px`,
                title: length === 23 ? 'The clocks go forward: 03:00 becomes 04:00, so this hour does not exist.' : 'The clocks go back: 04:00 becomes 03:00, so this hour happens twice.',
              },
              length === 23 ? '03:00 → 04:00 (no such hour)' : '04:00 → 03:00 (this hour twice)',
            )
          : null,
        blocks.map(({ item, from, to, column, columns: total }) => {
          const el = chip(item, day, { compact: true });
          el.classList.add('cal-block');
          el.style.top = `${(from / 60) * HOUR}px`;
          el.style.height = `${Math.max(((to - from) / 60) * HOUR - 2, 20)}px`;
          el.style.left = `calc(${(column / total) * 100}% + 2px)`;
          el.style.width = `calc(${100 / total}% - 4px)`;
          el.prepend(h('span', { class: 'cal-chip-time' }, `${clock(from)}–${clock(Math.min(to, 24 * 60 - 1))}`));
          return el;
        }),
        day === today.date ? h('div', { class: 'cal-now', style: `top: ${(today.minutes / 60) * HOUR}px`, title: `Now: ${today.time}` }) : null,
      );
      grid.addEventListener('click', (event) => {
        if (event.target !== grid) return;
        const minutes = Math.floor(((event.offsetY / HOUR) * 60) / 30) * 30;
        newEvent(day, clock(Math.min(minutes, 23 * 60 + 30)));
      });

      const head = h(
        'div',
        { class: `cal-col-head${day === today.date ? ' is-today' : ''}${dayClasses(day, parts(day).month)}` },
        h(
          'button',
          { class: 'cal-col-day', type: 'button', title: dayTitle(day), onclick: () => go('day', day) },
          h('span', { class: 'cal-col-weekday' }, WEEKDAYS[weekday(day) - 1]),
          h('span', { class: 'cal-col-date' }, formatDayMonth(day)),
        ),
        special.map((item) => h('div', { class: `cal-col-holiday is-${item.kind}`, title: item.nameEn }, item.name)),
        length !== 24 ? h('div', { class: 'cal-col-dst' }, length === 23 ? 'Clocks +1 h (23-hour day)' : 'Clocks −1 h (25-hour day)') : null,
      );
      const lane = h('div', { class: 'cal-allday', dataset: { date: day } }, allDay.map((item) => chip(item, day)));
      lane.addEventListener('click', (event) => {
        if (event.target === lane) newEvent(day);
      });
      acceptDrops(lane, day);
      acceptDrops(grid, day);
      return { head, lane, grid };
    });

    const scroller = h(
      'div',
      { class: 'cal-time-scroll' },
      h(
        'div',
        { class: 'cal-time-grid', style: `--days: ${days.length}; height: ${24 * HOUR}px` },
        h('div', { class: 'cal-hours' }, hours.map((hour) => h('span', { style: `top: ${hour * HOUR}px` }, `${pad(hour)}:00`))),
        columns.map((column) => column.grid),
      ),
    );
    // Open on working hours, like every calendar does.
    requestAnimationFrame(() => {
      const focus = days.includes(today.date) ? Math.max(today.minutes / 60 - 2, 0) : 7;
      scroller.scrollTop = focus * HOUR;
    });
    return h(
      'div',
      { class: `cal-time${days.length === 1 ? ' is-day' : ''}`, style: `--days: ${days.length}` },
      h(
        'div',
        { class: 'cal-time-head' },
        h('div', { class: 'cal-corner', title: 'ISO week number' }, `W${isoWeek(days[0]).week}`),
        columns.map((column) => column.head),
      ),
      h('div', { class: 'cal-time-allday' }, h('div', { class: 'cal-corner' }, 'All day'), columns.map((column) => column.lane)),
      scroller,
    );
  }

  // -- rendering ------------------------------------------------------------------------

  function render() {
    if (destroyed) return;
    renderHeader();
    root.dataset.view = view;
    if (view === 'year') replace(body, renderYear());
    else if (view === 'month') replace(body, renderMonth());
    else if (view === 'week') replace(body, renderTimeGrid(Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(cursor), index))));
    else replace(body, renderTimeGrid([cursor]));
  }

  function onKey(event) {
    if (event.ctrlKey || event.metaKey || event.altKey || isModalOpen() || hasOpenPopover()) return;
    if (event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    const found = VIEWS.find(([, , code]) => code === event.code);
    if (found) go(found[0]);
    else if (event.code === 'KeyT') go(view, now().date);
    else if (event.key === 'ArrowLeft') move(-1);
    else if (event.key === 'ArrowRight') move(1);
    else return;
    event.preventDefault();
  }
  document.addEventListener('keydown', onKey);
  // The line for "now" (and "today") follow the clock.
  let shownToday = now().date;
  const tick = setInterval(() => {
    if (document.hidden) return;
    const current = now();
    if (current.date !== shownToday) {
      shownToday = current.date;
      render(); // midnight: "today" moved on
      return;
    }
    const line = body.querySelector('.cal-now');
    if (line) line.style.top = `${(current.minutes / 60) * HOUR}px`;
  }, 30_000);

  show();
  return {
    flush: async () => {},
    destroy() {
      destroyed = true;
      document.removeEventListener('keydown', onKey);
      clearInterval(tick);
    },
  };
}
