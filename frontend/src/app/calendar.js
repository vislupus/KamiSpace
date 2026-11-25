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
import { createMonthPicker, dateInput, timeInput } from '../lib/datepicker.js';
import { h, replace } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openMenu } from '../lib/menu.js';
import { isModalOpen, openModal } from '../lib/modal.js';
import { hasOpenPopover, openPopover } from '../lib/popover.js';
import { toast, toastError } from '../lib/toast.js';
import { debounce, storageGet, storageSet } from '../lib/util.js';
import { copyPageLink, wantsNewTab } from './actions.js';
import { openPeek, peekedPageId } from './peek.js';
import { navigate, pagePath } from './router.js';
import { addRowPage, on, personalWorkspace, refreshTree, removePage } from './store.js';

const VIEWS = [
  ['year', 'Year', 'KeyY'],
  ['month', 'Month', 'KeyM'],
  ['week', 'Week', 'KeyW'],
  ['day', 'Day', 'KeyD'],
];
const HOUR = 48; // pixels per hour in the week and day views
const SNAP = 15; // minutes
const LANE = 22; // height of one line of events in a month cell
const COLORS = ['blue', 'green', 'purple', 'orange', 'pink', 'yellow', 'red', 'brown', 'gray'];
const VIEW_KEY = 'kamispace-calendar-view';
const HIDDEN_KEY = 'kamispace-calendar-hidden';
const SIDE_KEY = 'kamispace-calendar-side';

const pad = (value) => String(value).padStart(2, '0');
const dayOf = (moment) => moment.slice(0, 10);
const timeOf = (moment) => (moment.length > 10 ? moment.slice(11, 16) : null);
const minutesOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const clock = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
const lastDay = (item) => dayOf(item.end ?? item.start);
const formatMoment = (moment) => (moment.length > 10 ? `${formatDate(moment)} ${moment.slice(11, 16)}` : formatDate(moment));

/** A clock time moved by days and minutes ("2026-11-23T23:30" + 45 min → the next day, 00:15). */
function shiftMoment(moment, days, minutes) {
  if (moment.length <= 10) return addDays(moment, days);
  const total = minutesOf(timeOf(moment)) + minutes;
  const carry = Math.floor(total / 1440);
  return `${addDays(dayOf(moment), days + carry)}T${clock(((total % 1440) + 1440) % 1440)}`;
}

/** An event spanning days, or without a time, is drawn as a bar; a timed one as a line with a dot. */
const isBar = (item) => !timeOf(item.start) || dayOf(item.start) !== lastDay(item);

/**
 * Put events on lines so that none overlap: [{ item, from, to, lane }] with
 * `from` / `to` as column numbers in `days`.
 */
function layoutBars(days, list) {
  const first = days[0];
  const last = days.at(-1);
  const sorted = list
    .filter((item) => dayOf(item.start) <= last && lastDay(item) >= first)
    .sort(
      (a, b) =>
        Number(isBar(b)) - Number(isBar(a)) ||
        dayOf(a.start).localeCompare(dayOf(b.start)) ||
        daysBetween(dayOf(b.start), lastDay(b)) - daysBetween(dayOf(a.start), lastDay(a)) ||
        a.start.localeCompare(b.start),
    );
  // Which columns of each line are taken already.
  const lanes = [];
  return sorted.map((item) => {
    const from = Math.max(daysBetween(first, dayOf(item.start)), 0);
    const to = Math.min(daysBetween(first, lastDay(item)), days.length - 1);
    const free = (taken) => taken.slice(from, to + 1).every((used) => !used);
    let lane = lanes.findIndex(free);
    if (lane < 0) lane = lanes.push(new Array(days.length).fill(false)) - 1;
    for (let column = from; column <= to; column += 1) lanes[lane][column] = true;
    return { item, from, to, lane, startsBefore: dayOf(item.start) < first, endsAfter: lastDay(item) > last };
  });
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
  const hidden = new Set(storageGet(HIDDEN_KEY, []));
  let sideOpen = storageGet(SIDE_KEY, true);
  let shownRange = null;
  let timeScroll = null; // where the time grid is scrolled to

  const header = h('div', { class: 'cal-head' });
  const body = h('div', { class: 'cal-body' });
  const side = h('aside', { class: 'cal-side', 'aria-label': 'Calendars' });
  const root = h('div', { class: 'cal' }, side, h('div', { class: 'cal-main' }, header, body));
  replace(container, root);

  const NO_HOLIDAYS = [];
  const showHolidays = () => !hidden.has('holidays');
  const special = (day) => (showHolidays() ? holidaysOn(day) : NO_HOLIDAYS);
  /** A row has its own colour, or that of its database, or one given by the database's number. */
  const paletteColor = (databaseId) => COLORS[databaseId % COLORS.length];
  const colorOf = (item) => (item.kind === 'task' ? 'task' : (item.color ?? paletteColor(item.database_id)));

  // Worked out once per drawing instead of once per day shown: which events
  // are visible, and which of them fall on each day.
  let frame = {};
  const visibleItems = () => {
    frame.visible ??= items.filter((item) => (item.kind === 'task' ? !hidden.has('tasks') : !hidden.has(`db:${item.database_id}`)));
    return frame.visible;
  };
  const NOTHING = [];
  function onDay(day) {
    if (!frame.days) {
      frame.days = new Map();
      const [first, last] = range();
      for (const item of visibleItems()) {
        const from = dayOf(item.start) < first ? first : dayOf(item.start);
        const to = lastDay(item) > last ? last : lastDay(item);
        for (let current = from; current <= to; current = addDays(current, 1)) {
          const list = frame.days.get(current);
          if (list) list.push(item);
          else frame.days.set(current, [item]);
        }
      }
    }
    return frame.days.get(day) ?? NOTHING;
  }
  const today = () => (frame.today ??= now().date);

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
    // Marks the calendar as waiting for data (also a signal for tests).
    root.dataset.busy = '1';
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
    if (current === request) delete root.dataset.busy;
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

  function describe(item) {
    return [
      item.title || 'Untitled',
      item.end ? `${formatMoment(item.start)} → ${formatMoment(item.end)}` : formatMoment(item.start),
      item.kind === 'task'
        ? item.page_title
          ? `Task in “${item.page_title}”`
          : 'Task'
        : `${item.database_title || 'Database'} · ${item.property}`,
    ].join('\n');
  }

  async function removeItem(item) {
    try {
      await api.delete(`/api/pages/${item.id}`);
      removePage(item.id);
      load({ force: true });
      toast('Moved to the recycle bin', {
        action: {
          label: 'Undo',
          onClick: async () => {
            await api.post(`/api/trash/${item.id}/restore`).catch((error) => toastError(error));
            refreshTree();
            load({ force: true });
          },
        },
      });
    } catch (error) {
      toastError(error, 'Could not delete the event');
    }
  }

  function itemMenu(item, point) {
    if (item.id === null || item.id === undefined) return;
    openMenu({
      anchor: () => new DOMRect(point.x, point.y, 0, 0),
      items: [
        { label: 'Open in side peek', icon: 'peek', onSelect: () => openPeek(item.id) },
        { label: 'Open as a full page', icon: 'maximize', onSelect: () => navigate(pagePath(item.id)) },
        { label: 'Open in a new tab', icon: 'external', onSelect: () => window.open(pagePath(item.id), '_blank', 'noopener') },
        { separator: true },
        { label: 'Copy link', icon: 'link', onSelect: () => copyPageLink(item.id) },
        item.kind === 'row' && item.can_edit
          ? {
              label: 'Color',
              icon: 'palette',
              submenu: colorItems(item.own_color, (color) =>
                saveColor(`/api/databases/${item.database_id}/rows/${item.id}`, color, () => {
                  // Shown at once: the row's colour, or back to its database's.
                  const source = sources.find((entry) => entry.id === item.database_id);
                  for (const entry of items) {
                    if (entry.kind === 'row' && entry.id === item.id) {
                      entry.own_color = color;
                      entry.color = color ?? source?.color ?? null;
                    }
                  }
                }),
              ),
            }
          : null,
        item.kind === 'row' && item.can_edit ? { separator: true } : null,
        item.kind === 'row' && item.can_edit
          ? { label: 'Delete', icon: 'trash-2', danger: true, onSelect: () => removeItem(item) }
          : null,
      ],
    });
  }

  /** Menu items to choose a colour; the first one goes back to the automatic colour. */
  function colorItems(current, onPick, automatic = 'Same as the calendar') {
    return [
      { label: automatic, icon: 'refresh', checked: !current, onSelect: () => onPick(null) },
      { separator: true },
      ...COLORS.map((color) => ({
        label: color[0].toUpperCase() + color.slice(1),
        swatch: color,
        checked: current === color,
        onSelect: () => onPick(color),
      })),
    ];
  }

  async function saveColor(url, color, apply) {
    apply();
    render();
    try {
      await api.patch(url, { color });
    } catch (error) {
      toastError(error, 'Could not save the color');
      load({ force: true });
    }
  }

  /** A link to the event's page that opens beside the calendar. */
  function eventElement(item, className, children) {
    const linked = item.id !== null && item.id !== undefined;
    const el = h(
      linked ? 'a' : 'span',
      {
        class: `cal-event ${className}${item.kind === 'task' ? ' is-task' : ''}${item.checked ? ' is-done' : ''}${linked && peekedPageId() === item.id ? ' is-peeked' : ''}`,
        href: linked ? pagePath(item.id) : null,
        dataset: { ...(linked ? { id: item.id } : {}), color: colorOf(item) },
        title: describe(item),
      },
      children,
    );
    if (linked) {
      el.addEventListener('click', (event) => {
        if (wantsNewTab(event)) return; // the browser opens the link in a new tab
        event.preventDefault();
        if (el.dataset.dragged) return;
        openPeek(item.id);
      });
      el.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        itemMenu(item, { x: event.clientX, y: event.clientY });
      });
    }
    return el;
  }

  /** One line in a month cell or the all-day row. */
  function chip(item, { continued = false, continues = false } = {}) {
    const time = timeOf(item.start);
    const bar = isBar(item);
    const el = eventElement(
      item,
      `cal-chip${bar ? ' is-bar' : ''}${continued ? ' is-continued' : ''}${continues ? ' continues' : ''}`,
      [
        item.kind === 'task' ? icon(item.checked ? 'check-circle' : 'tasks', 12) : bar ? null : h('span', { class: 'cal-dot' }),
        time && !continued ? h('span', { class: 'cal-chip-time' }, time) : null,
        h('span', { class: 'cal-chip-title' }, item.title || 'Untitled'),
      ],
    );
    if (item.kind === 'row' && item.can_edit) {
      el.draggable = true;
      el.addEventListener('dragstart', (event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(
          'application/x-kamispace-event',
          JSON.stringify({ id: item.id, property: item.property_id, from: el.dataset.day ?? dayOf(item.start) }),
        );
        event.dataTransfer.setData('text/plain', item.title || 'Untitled');
      });
    }
    return el;
  }

  async function saveDates(item, value) {
    Object.assign(item, { start: value.start, end: value.end ?? null });
    render();
    root.dataset.busy = '1';
    try {
      await api.patch(`/api/databases/${item.database_id}/rows/${item.id}`, { props: { [item.property_id]: value } });
    } catch (error) {
      toastError(error, 'Could not move the event');
    }
    load({ force: true });
  }

  /** Move an event by whole days (dragging a chip to another day). */
  function moveItem(id, propertyId, fromDay, toDay) {
    const item = items.find((entry) => entry.kind === 'row' && entry.id === id && entry.property_id === propertyId);
    const shift = daysBetween(fromDay, toDay);
    if (!item || !shift) return;
    saveDates(item, { start: shiftMoment(item.start, shift, 0), ...(item.end ? { end: shiftMoment(item.end, shift, 0) } : {}) });
  }

  /** Let chips be dropped on `el`; `dayAt(event)` says which day the pointer is over. */
  function acceptDrops(el, dayAt) {
    el.addEventListener('dragover', (event) => {
      if (!event.dataTransfer.types.includes('application/x-kamispace-event')) return;
      event.preventDefault();
      el.querySelectorAll('.is-drop-target').forEach((cell) => cell.classList.remove('is-drop-target'));
      dayAt(event)?.cell?.classList.add('is-drop-target');
    });
    el.addEventListener('dragleave', (event) => {
      if (!el.contains(event.relatedTarget)) el.querySelectorAll('.is-drop-target').forEach((cell) => cell.classList.remove('is-drop-target'));
    });
    el.addEventListener('drop', (event) => {
      el.querySelectorAll('.is-drop-target').forEach((cell) => cell.classList.remove('is-drop-target'));
      const raw = event.dataTransfer.getData('application/x-kamispace-event');
      const target = dayAt(event);
      if (!raw || !target) return;
      event.preventDefault();
      const dropped = JSON.parse(raw);
      moveItem(dropped.id, dropped.property, dropped.from, target.day);
    });
  }

  /** The day cell under the pointer, among elements that carry data-date. */
  const cellUnder = (scope) => (event) => {
    const cells = [...scope.querySelectorAll('[data-date]')];
    const cell = cells.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return event.clientX >= rect.left && event.clientX < rect.right && event.clientY >= rect.top && event.clientY < rect.bottom;
    });
    return cell ? { cell, day: cell.dataset.date } : null;
  };

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

  function newEvent(day, time = null, until = null) {
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
                  if (sources.some((source) => source.can_edit)) newEvent(day, time, until);
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
    const endTime = timeInput({
      value: until ?? clock(Math.min(minutesOf(time ?? '09:00') + 60, 23 * 60 + 59)),
      label: 'End time',
      onChange: () => {},
    });
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
            const created = await api.post(`/api/databases/${chosen.source.id}/rows`, {
              title: name.value.trim(),
              props: { [chosen.property.id]: value },
            });
            addRowPage(chosen.source.id, created);
            storageSet('kamispace-calendar-target', `${chosen.source.id}:${chosen.property.id}`);
            hidden.delete(`db:${chosen.source.id}`); // a new event must be visible
            modal.close();
            load({ force: true });
          } catch (problem) {
            error.textContent = problem.message || 'Could not create the event';
          }
        },
      },
      name,
      h('label', { class: 'field-label' }, 'Calendar (database)'),
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

  // -- holidays, on request -------------------------------------------------------------

  function openHolidays() {
    const { year } = parts(cursor);
    const { forward, back } = clockChanges(year);
    const modal = openModal({
      title: `Official holidays ${year}`,
      className: 'cal-holidays-modal',
      content: h(
        'div',
        { class: 'cal-holidays' },
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
            holidays(year).map((item) =>
              h(
                'tr',
                { class: `is-${item.kind}` },
                h(
                  'td',
                  null,
                  h(
                    'button',
                    {
                      class: 'cal-link',
                      type: 'button',
                      onclick: () => {
                        modal.close();
                        go('day', item.date);
                      },
                    },
                    formatDate(item.date),
                  ),
                ),
                h('td', null, WEEKDAYS_LONG[weekday(item.date) - 1]),
                h('td', null, item.name, h('div', { class: 'muted' }, item.nameEn)),
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
    });
  }

  // -- the panel on the left --------------------------------------------------------------

  const picker = createMonthPicker({ selected: cursor, onPick: (day) => go(view === 'year' ? 'day' : view, day) });

  function toggleSource(key) {
    if (hidden.has(key)) hidden.delete(key);
    else hidden.add(key);
    storageSet(HIDDEN_KEY, [...hidden]);
    render();
  }

  function renderSide() {
    side.hidden = !sideOpen;
    root.classList.toggle('has-side', sideOpen);
    if (!sideOpen) return;
    picker.select(view === 'week' ? [startOfWeek(cursor), addDays(startOfWeek(cursor), 6)] : cursor);
    picker.show(cursor);
    const row = (key, label, color, hint = '', source = null) => {
      const box = h('input', { type: 'checkbox', checked: !hidden.has(key), 'aria-label': label });
      box.addEventListener('change', () => toggleSource(key));
      // The colour of a database's entries is chosen here, for everyone.
      const paint = source?.can_edit
        ? h(
            'button',
            {
              class: 'cal-source-color',
              type: 'button',
              title: 'Color of this calendar',
              'aria-label': `Color of ${label}`,
              onclick: (event) => {
                event.preventDefault();
                event.stopPropagation();
                openMenu({
                  anchor: event.currentTarget,
                  placement: 'bottom-end',
                  items: colorItems(
                    source.color,
                    (picked) =>
                      saveColor(`/api/databases/${source.id}`, picked, () => {
                        source.color = picked;
                        for (const entry of items) {
                          if (entry.kind === 'row' && entry.database_id === source.id && !entry.own_color) entry.color = picked;
                        }
                      }),
                    'Automatic',
                  ),
                });
              },
            },
            icon('palette', 13),
          )
        : null;
      return h('label', { class: 'cal-source', dataset: { color }, title: hint || label }, box, h('span', { class: 'cal-source-name' }, label), paint);
    };
    replace(
      side,
      picker.el,
      h('div', { class: 'cal-side-title' }, 'Calendars'),
      sources.length
        ? sources.map((source) =>
            row(`db:${source.id}`, source.title || 'Untitled', source.color ?? paletteColor(source.id), 'Rows of this database that have a date', source),
          )
        : h('div', { class: 'cal-side-empty' }, 'Databases with a Date property show up here.'),
      h('div', { class: 'cal-side-title' }, 'Other'),
      row('tasks', 'My tasks with a due date', 'task'),
      row('holidays', 'Holidays in Bulgaria', 'holiday', 'Calculated here, not downloaded'),
      h(
        'div',
        { class: 'cal-zone', title: `All times are clock times in ${TIME_ZONE}, whatever the time zone of this computer` },
        `${TIME_ZONE} · UTC+${offsetAt(Date.now()) / 60}`,
      ),
    );
  }

  // -- header -------------------------------------------------------------------------

  function renderHeader() {
    replace(
      header,
      h(
        'div',
        { class: 'cal-nav' },
        h(
          'button',
          {
            class: 'icon-button',
            type: 'button',
            title: sideOpen ? 'Hide the calendar list' : 'Show the calendar list',
            'aria-label': sideOpen ? 'Hide the calendar list' : 'Show the calendar list',
            'aria-pressed': String(sideOpen),
            onclick: () => {
              sideOpen = !sideOpen;
              storageSet(SIDE_KEY, sideOpen);
              render();
            },
          },
          icon('sidebar', 16),
        ),
        h('button', { class: 'button button-small', type: 'button', title: 'Today (T)', onclick: () => go(view, now().date) }, 'Today'),
        h('button', { class: 'icon-button', type: 'button', title: 'Previous (←)', 'aria-label': 'Previous', onclick: () => move(-1) }, icon('chevron-left', 16)),
        h('button', { class: 'icon-button', type: 'button', title: 'Next (→)', 'aria-label': 'Next', onclick: () => move(1) }, icon('chevron-right', 16)),
        h('h1', { class: 'cal-title' }, title()),
      ),
      h(
        'div',
        { class: 'cal-tools' },
        h(
          'button',
          { class: 'button button-small button-ghost', type: 'button', title: `The official holidays of ${parts(cursor).year}`, onclick: openHolidays },
          icon('flag', 14),
          'Holidays',
        ),
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
        h('button', { class: 'button button-primary button-small', type: 'button', onclick: () => newEvent(cursor) }, icon('plus', 14), 'New event'),
      ),
    );
  }

  // -- year ---------------------------------------------------------------------------

  function dayClasses(day, month) {
    const list = special(day);
    return (
      `${parts(day).month === month ? '' : ' is-outside'}${day === today() ? ' is-today' : ''}` +
      `${isWeekend(day) ? ' is-weekend' : ''}` +
      `${list.some((item) => item.off && item.kind !== 'compensation') ? ' is-holiday' : ''}` +
      `${list.some((item) => item.kind === 'compensation') ? ' is-lieu' : ''}` +
      `${list.some((item) => item.kind === 'school') ? ' is-school' : ''}`
    );
  }

  function dayTitle(day) {
    const names = special(day).map((item) => `${item.name} — ${item.nameEn}`);
    const count = onDay(day).length;
    return [`${WEEKDAYS_LONG[weekday(day) - 1]}, ${formatDate(day)}`, ...names, count ? `${count} event${count === 1 ? '' : 's'}` : null]
      .filter(Boolean)
      .join('\n');
  }

  function renderYear() {
    const { year } = parts(cursor);
    const busy = new Set();
    for (const item of visibleItems()) {
      for (let day = dayOf(item.start) < `${year}-01-01` ? `${year}-01-01` : dayOf(item.start); day <= lastDay(item) && day <= `${year}-12-31`; day = addDays(day, 1)) busy.add(day);
    }
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
              { class: 'cal-mini-week', type: 'button', title: `Week ${week.week} of ${week.year}`, onclick: () => go('week', week.days[0]) },
              String(week.week),
            ),
            ...week.days.map((day) =>
              // Days of the neighbouring months are left empty, so every date appears once.
              parts(day).month === month
                ? h(
                    'button',
                    {
                      class: `cal-mini-day${dayClasses(day, month)}${busy.has(day) ? ' has-events' : ''}`,
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
    return h(
      'div',
      { class: 'cal-year' },
      h('div', { class: 'cal-year-grid' }, months),
      showHolidays()
        ? h(
            'div',
            { class: 'cal-legend cal-year-legend' },
            h('span', { class: 'cal-key is-holiday' }, 'Holiday'),
            h('span', { class: 'cal-key is-lieu' }, 'Day off in lieu'),
            h('span', { class: 'cal-key is-school' }, 'No classes'),
            h('span', { class: 'cal-key is-event' }, 'Has events'),
          )
        : null,
    );
  }

  // -- month --------------------------------------------------------------------------

  /** Everything on one day, in a small popover ("+3 more"). */
  function openDay(day, anchor) {
    const list = onDay(day);
    openPopover({
      anchor,
      placement: 'bottom-start',
      className: 'cal-day-popover',
      content: h(
        'div',
        { class: 'cal-day-list' },
        h(
          'button',
          { class: 'cal-day-list-title', type: 'button', onclick: () => go('day', day) },
          `${WEEKDAYS_LONG[weekday(day) - 1]}, ${formatDate(day)}`,
        ),
        special(day).map((item) => h('div', { class: `cal-col-holiday is-${item.kind}` }, item.name)),
        list.map((item) => chip(item, { continued: dayOf(item.start) < day })),
      ),
    });
  }

  function renderMonth() {
    const { year, month } = parts(cursor);
    const weeks = monthWeeks(year, month);
    // As many lines of events as the height of a week allows.
    const available = Math.max(body.clientHeight - 30, 300) / weeks.length;
    const lanes = Math.max(Math.floor((available - 30) / LANE), 2);
    const grid = h(
      'div',
      { class: 'cal-month', style: `--weeks: ${weeks.length}` },
      h(
        'div',
        { class: 'cal-month-head' },
        h('span', { class: 'cal-week-number', title: 'ISO week number' }, 'W'),
        WEEKDAYS_LONG.map((name, index) => h('span', { class: `cal-weekday${index >= 5 ? ' is-weekend' : ''}` }, name)),
      ),
      weeks.map((week) => {
        const bars = layoutBars(week.days, visibleItems());
        // Where a day has more than fits, the last line says how many more.
        const overflow = week.days.map((_, column) => bars.filter((bar) => bar.from <= column && bar.to >= column).length > lanes);
        const shown = bars.filter((bar) => {
          const crowded = overflow.slice(bar.from, bar.to + 1).some(Boolean);
          return bar.lane < (crowded ? lanes - 1 : lanes);
        });
        const row = h(
          'div',
          { class: 'cal-week-row' },
          h(
            'button',
            { class: 'cal-week-number', type: 'button', title: `Week ${week.week} of ${week.year}`, onclick: () => go('week', week.days[0]) },
            String(week.week),
          ),
          week.days.map((day, column) => {
            const names = special(day);
            const more = bars.filter((bar) => bar.from <= column && bar.to >= column && !shown.includes(bar)).length;
            const cell = h(
              'div',
              { class: `cal-day${dayClasses(day, month)}`, dataset: { date: day } },
              h(
                'div',
                { class: 'cal-day-head' },
                h(
                  'button',
                  { class: 'cal-day-number', type: 'button', title: dayTitle(day), onclick: () => go('day', day) },
                  String(parts(day).day),
                ),
                names.length
                  ? h('span', { class: 'cal-day-holiday', title: names.map((item) => `${item.name} — ${item.nameEn}`).join('\n') }, names.map((item) => item.name).join(' · '))
                  : null,
              ),
              more
                ? h(
                    'button',
                    {
                      class: 'cal-more',
                      type: 'button',
                      style: `top: ${30 + (lanes - 1) * LANE}px`,
                      onclick: (event) => {
                        event.stopPropagation();
                        openDay(day, event.currentTarget);
                      },
                    },
                    `+${more} more`,
                  )
                : null,
            );
            cell.addEventListener('click', (event) => {
              if (event.target === cell || event.target.classList.contains('cal-day-head')) newEvent(day);
            });
            return cell;
          }),
          h(
            'div',
            { class: 'cal-week-events' },
            shown.map(({ item, from, to, lane, startsBefore, endsAfter }) => {
              const el = chip(item, { continued: startsBefore, continues: endsAfter });
              el.style.gridColumn = `${from + 1} / ${to + 2}`;
              el.style.gridRow = String(lane + 1);
              // Dragged by whole days from the day the bar starts on in this week.
              el.dataset.day = week.days[from] > dayOf(item.start) ? dayOf(item.start) : week.days[from];
              return el;
            }),
          ),
        );
        acceptDrops(row, cellUnder(row));
        return row;
      }),
    );
    return grid;
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

  /**
   * Drag a block in the time grid: its body moves it (also to another day),
   * its lower edge changes when it ends. Steps of a quarter of an hour.
   */
  function dragBlock(event, el, item, grids, mode) {
    if (event.button !== 0 || !item.can_edit || item.kind !== 'row') return;
    const startX = event.clientX;
    const startY = event.clientY;
    const top = parseFloat(el.style.top);
    const height = parseFloat(el.style.height);
    const columnWidth = grids[0].getBoundingClientRect().width;
    let minutes = 0;
    let days = 0;
    let dragging = false;
    // From the first moment: the pointer leaves a small block (or its lower
    // edge) within a few pixels, and the block must keep hearing about it.
    el.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) < 5) return;
      if (!dragging) {
        dragging = true;
        el.classList.add('is-dragging');
      }
      minutes = Math.round(((dy / HOUR) * 60) / SNAP) * SNAP;
      if (mode === 'resize') {
        el.style.height = `${Math.max(height + (minutes / 60) * HOUR, (SNAP / 60) * HOUR)}px`;
      } else {
        days = grids.length > 1 ? Math.round(dx / columnWidth) : 0;
        el.style.top = `${top + (minutes / 60) * HOUR}px`;
        el.style.transform = `translateX(${days * columnWidth}px)`;
      }
    };
    const stop = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', stop);
      el.removeEventListener('pointercancel', stop);
      if (!dragging) return;
      // The click that ends the drag must not open the event.
      el.dataset.dragged = '1';
      setTimeout(() => delete el.dataset.dragged, 0);
      if (!minutes && !days) {
        render();
        return;
      }
      const end = item.end ?? shiftMoment(item.start, 0, 60);
      if (mode === 'resize') {
        const next = shiftMoment(end, 0, minutes);
        saveDates(item, { start: item.start, end: next > item.start ? next : shiftMoment(item.start, 0, SNAP) });
      } else {
        saveDates(item, { start: shiftMoment(item.start, days, minutes), end: shiftMoment(end, days, minutes) });
      }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
  }

  /** Press and drag on an empty part of a day: a new event from … to. */
  function dragNew(event, grid, day) {
    if (event.button !== 0 || event.target !== grid) return;
    const rect = grid.getBoundingClientRect();
    const at = (clientY) => Math.max(0, Math.min(Math.round((((clientY - rect.top) / HOUR) * 60) / SNAP) * SNAP, 24 * 60));
    const from = at(event.clientY);
    let to = from;
    const ghost = h('div', { class: 'cal-ghost' });
    const draw = () => {
      const first = Math.min(from, to);
      const last = Math.max(from, to);
      ghost.style.top = `${(first / 60) * HOUR}px`;
      ghost.style.height = `${Math.max(((last - first) / 60) * HOUR, 2)}px`;
      ghost.textContent = last > first ? `${clock(first)}–${clock(Math.min(last, 24 * 60 - 1))}` : '';
    };
    const move = (moveEvent) => {
      to = at(moveEvent.clientY);
      if (!ghost.isConnected) grid.append(ghost);
      draw();
    };
    const stop = () => {
      grid.removeEventListener('pointermove', move);
      grid.removeEventListener('pointerup', stop);
      grid.removeEventListener('pointercancel', stop);
      ghost.remove();
      const first = Math.min(from, to);
      const last = Math.max(from, to);
      if (last - first >= SNAP) newEvent(day, clock(first), clock(Math.min(last, 24 * 60 - 1)));
      else newEvent(day, clock(Math.min(Math.floor(first / 30) * 30, 23 * 60 + 30)));
    };
    grid.setPointerCapture(event.pointerId);
    grid.addEventListener('pointermove', move);
    grid.addEventListener('pointerup', stop);
    grid.addEventListener('pointercancel', stop);
  }

  function renderTimeGrid(days, keepScroll = false) {
    const today = now();
    const all = visibleItems();
    const grids = [];
    const heads = days.map((day) => {
      const names = special(day);
      const length = hoursInDay(day);
      return h(
        'div',
        { class: `cal-col-head${dayClasses(day, parts(day).month)}` },
        h(
          'button',
          { class: 'cal-col-day', type: 'button', title: dayTitle(day), onclick: () => go('day', day) },
          h('span', { class: 'cal-col-weekday' }, WEEKDAYS[weekday(day) - 1]),
          h('span', { class: 'cal-col-date' }, formatDayMonth(day)),
        ),
        names.map((item) => h('div', { class: `cal-col-holiday is-${item.kind}`, title: item.nameEn }, item.name)),
        length !== 24 ? h('div', { class: 'cal-col-dst' }, length === 23 ? 'Clocks +1 h (23-hour day)' : 'Clocks −1 h (25-hour day)') : null,
      );
    });

    // All-day and multi-day events: bars across the days they cover.
    const bars = layoutBars(days, all.filter(isBar));
    const lanes = Math.max(...bars.map((bar) => bar.lane + 1), 1);
    const allDay = h(
      'div',
      { class: 'cal-allday', style: `--lanes: ${lanes}` },
      days.map((day) => {
        const cell = h('div', { class: `cal-allday-cell${isWeekend(day) ? ' is-weekend' : ''}`, dataset: { date: day } });
        cell.addEventListener('click', () => newEvent(day));
        return cell;
      }),
      h(
        'div',
        { class: 'cal-allday-events' },
        bars.map(({ item, from, to, lane, startsBefore, endsAfter }) => {
          const el = chip(item, { continued: startsBefore, continues: endsAfter });
          el.style.gridColumn = `${from + 1} / ${to + 2}`;
          el.style.gridRow = String(lane + 1);
          el.dataset.day = days[from] > dayOf(item.start) ? dayOf(item.start) : days[from];
          return el;
        }),
      ),
    );
    acceptDrops(allDay, cellUnder(allDay));

    const columns = days.map((day) => {
      const length = hoursInDay(day);
      const blocks = arrange(
        all
          .filter((item) => !isBar(item) && dayOf(item.start) === day)
          .map((item) => {
            const from = minutesOf(timeOf(item.start));
            const to = item.end ? minutesOf(timeOf(item.end)) : from + 60;
            return { item, from, to: Math.max(Math.min(to, 24 * 60), from + SNAP) };
          }),
      );
      const grid = h(
        'div',
        {
          class: `cal-grid-day${isWeekend(day) ? ' is-weekend' : ''}${special(day).some((item) => item.off) ? ' is-holiday' : ''}${day === today.date ? ' is-today' : ''}`,
          dataset: { date: day },
        },
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
          const short = to - from <= 30;
          const el = eventElement(item, `cal-block${short ? ' is-short' : ''}`, [
            h('span', { class: 'cal-chip-title' }, item.title || 'Untitled'),
            h('span', { class: 'cal-chip-time' }, `${clock(from)}–${clock(Math.min(to, 24 * 60 - 1))}`),
          ]);
          el.style.top = `${(from / 60) * HOUR}px`;
          el.style.height = `${Math.max(((to - from) / 60) * HOUR - 2, 18)}px`;
          el.style.left = `calc(${(column / total) * 100}% + 2px)`;
          el.style.width = `calc(${100 / total}% - 5px)`;
          el.draggable = false;
          if (item.kind === 'row' && item.can_edit) {
            const grip = h('span', { class: 'cal-block-grip', title: 'Drag to change the end' });
            grip.addEventListener('pointerdown', (event) => {
              event.stopPropagation();
              event.preventDefault();
              dragBlock(event, el, item, grids, 'resize');
            });
            el.append(grip);
            el.addEventListener('pointerdown', (event) => dragBlock(event, el, item, grids, 'move'));
          }
          return el;
        }),
        day === today.date
          ? h('div', { class: 'cal-now', style: `top: ${(today.minutes / 60) * HOUR}px`, title: `Now: ${today.time}` }, h('span', { class: 'cal-now-time' }, today.time))
          : null,
      );
      grid.addEventListener('pointerdown', (event) => dragNew(event, grid, day));
      grids.push(grid);
      return grid;
    });

    const scroller = h(
      'div',
      { class: 'cal-time-scroll' },
      h(
        'div',
        { class: 'cal-time-grid', style: `--days: ${days.length}; height: ${24 * HOUR}px` },
        h(
          'div',
          { class: 'cal-hours' },
          Array.from({ length: 24 }, (_, hour) =>
            // The label of "now" takes the place of an hour label right next to it.
            h('span', { style: `top: ${hour * HOUR}px`, hidden: days.includes(today.date) && Math.abs(hour * 60 - today.minutes) < 16 }, `${pad(hour)}:00`),
          ),
        ),
        columns,
      ),
    );
    // Open on the working day (or shortly before "now"); a redraw of the
    // same view stays where it was.
    const focus = days.includes(today.date) ? Math.max(today.minutes / 60 - 2, 0) : 7.5;
    const target = keepScroll && timeScroll !== null ? timeScroll : focus * HOUR;
    timeScroll = target;
    const place = () => {
      scroller.scrollTop = target;
      // From now on the place is wherever the user scrolls to.
      scroller.addEventListener('scroll', () => {
        timeScroll = scroller.scrollTop;
      });
    };
    // Before the first paint (no jump), and once more when the layout is final.
    queueMicrotask(() => {
      scroller.scrollTop = target;
    });
    requestAnimationFrame(place);
    return h(
      'div',
      { class: `cal-time${days.length === 1 ? ' is-day' : ''}`, style: `--days: ${days.length}` },
      h('div', { class: 'cal-time-head' }, h('div', { class: 'cal-corner', title: 'ISO week number' }, `W${isoWeek(days[0]).week}`), heads),
      h('div', { class: 'cal-time-allday' }, h('div', { class: 'cal-corner' }, 'All day'), allDay),
      scroller,
    );
  }

  // -- rendering ------------------------------------------------------------------------

  function render() {
    if (destroyed) return;
    frame = {};
    // Redrawing the same view (an event moved, a calendar hidden) keeps the place.
    const scroll = root.dataset.view === view && shownRange === range().join('|');
    shownRange = range().join('|');
    renderHeader();
    renderSide();
    root.dataset.view = view;
    if (view === 'year') replace(body, renderYear());
    else if (view === 'month') replace(body, renderMonth());
    else if (view === 'week') replace(body, renderTimeGrid(Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(cursor), index)), scroll));
    else replace(body, renderTimeGrid([cursor], scroll));
  }

  function onKey(event) {
    if (event.ctrlKey || event.metaKey || event.altKey || isModalOpen() || hasOpenPopover()) return;
    if (event.target.closest?.('input, textarea, select, [contenteditable="true"], .peek')) return;
    const found = VIEWS.find(([, , code]) => code === event.code);
    if (found) go(found[0]);
    else if (event.code === 'KeyT') go(view, now().date);
    else if (event.key === 'ArrowLeft') move(-1);
    else if (event.key === 'ArrowRight') move(1);
    else return;
    event.preventDefault();
  }
  document.addEventListener('keydown', onKey);
  const onResize = debounce(() => {
    if (!destroyed && view === 'month') render();
  }, 150);
  window.addEventListener('resize', onResize);
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
    if (line) {
      line.style.top = `${(current.minutes / 60) * HOUR}px`;
      line.firstChild.textContent = current.time;
    }
  }, 30_000);
  const subscriptions = [
    // An event changed on its page (in the side peek, for example).
    on('row-updated', () => load({ force: true })),
    on('peek', ({ closed }) => {
      if (closed) load({ force: true });
      else render();
    }),
  ];

  show();
  return {
    flush: async () => {},
    destroy() {
      destroyed = true;
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      clearInterval(tick);
      for (const unsubscribe of subscriptions) unsubscribe();
    },
  };
}
