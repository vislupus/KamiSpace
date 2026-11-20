// A database: a set of rows (each one a page) with properties, shown as a
// table or as a board. Used inline inside a page (the "database" block) and
// as the whole page when a database is opened by itself.
import { api } from '../../lib/api.js';
import { h, replace } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { openMenu } from '../../lib/menu.js';
import { confirmDialog, promptDialog } from '../../lib/modal.js';
import { openPopover } from '../../lib/popover.js';
import { toast, toastError } from '../../lib/toast.js';
import { debounce, storageGet, storageSet } from '../../lib/util.js';
import { navigate, pagePath } from '../router.js';
import { patchPage, refreshTree, store } from '../store.js';
import { renderBoard } from './board.js';
import { renderTable } from './table.js';
import {
  ADDABLE_TYPES,
  NUMBER_FORMATS,
  TYPES,
  compareRows,
  filterOps,
  hasOptions,
  matchesFilter,
  newId,
  textOf,
  valueOf,
} from './values.js';

const VIEW_ICONS = { table: 'table', board: 'kanban' };
const GROUPABLE = new Set(['select', 'status', 'person']);

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * @param {object} options
 * @param {HTMLElement} options.container
 * @param {number} options.databaseId
 * @param {boolean} [options.inline]   inside a page: shows its own title
 * @returns {{ destroy(): void, reload(): Promise<void> }}
 */
export function mountDatabase({ container, databaseId, inline = false }) {
  const toolbar = h('div', { class: 'db-toolbar' });
  const titleBar = h('div', { class: 'db-title-row' });
  const body = h('div', { class: 'db-body' });
  const root = h('div', { class: `db${inline ? ' is-inline' : ''}` }, titleBar, toolbar, body);
  replace(container, root);

  const viewKey = `kamispace-db-view-${databaseId}`;
  let db = null;
  let destroyed = false;
  let viewId = storageGet(viewKey, null);
  let query = '';
  let searchOpen = false;
  let schemaRequest = 0;
  /** Row whose title is edited right after the next render (a new row). */
  let editTitleOf = null;

  const url = `/api/databases/${databaseId}`;

  // -- reading the state ----------------------------------------------------------

  const currentView = () => db.views.find((view) => view.id === viewId) ?? db.views[0];
  const property = (id) => db.properties.find((prop) => prop.id === id) ?? null;

  /** Properties in the order of a view, the title first. */
  function orderedProperties(view) {
    const rank = new Map((view.order ?? []).map((id, index) => [id, index]));
    return [...db.properties].sort((a, b) => {
      if (a.type === 'title') return -1;
      if (b.type === 'title') return 1;
      return (rank.get(a.id) ?? 1000 + db.properties.indexOf(a)) - (rank.get(b.id) ?? 1000 + db.properties.indexOf(b));
    });
  }

  function shownProperties(view) {
    const hidden = new Set(view.hidden ?? []);
    return orderedProperties(view).filter((prop) => !hidden.has(prop.id));
  }

  /** Rows after the view's filters, the search box and its sort order. */
  function visibleRows(view) {
    let rows = db.rows;
    for (const rule of view.filter ?? []) {
      const prop = property(rule.property);
      if (prop) rows = rows.filter((row) => matchesFilter(row, prop, rule));
    }
    const needle = query.trim().toLowerCase();
    if (needle) {
      rows = rows.filter((row) =>
        db.properties.some((prop) => textOf(prop, valueOf(row, prop)).toLowerCase().includes(needle)),
      );
    }
    const sorts = (view.sort ?? []).map((rule) => [property(rule.property), rule.direction]).filter(([prop]) => prop);
    if (sorts.length) {
      rows = [...rows].sort((a, b) => {
        for (const [prop, direction] of sorts) {
          const order = compareRows(a, b, prop, direction);
          if (order) return order;
        }
        return a.position - b.position || a.id - b.id;
      });
    }
    return rows;
  }

  // -- writing --------------------------------------------------------------------

  /** Rows with a save on its way: row id → number of requests. */
  const rowSaves = new Map();

  // Schema saves run one after another, and row saves wait for them: a row
  // may use an option that the save before it has only just created.
  let schemaSaves = Promise.resolve();
  function pushSchema(changes) {
    schemaRequest += 1;
    schemaSaves = schemaSaves.then(() => sendSchema(changes));
    return schemaSaves;
  }

  async function sendSchema(changes) {
    try {
      const body = changes();
      const result = await api.patch(url, body);
      schemaRequest -= 1;
      // Newer changes are still waiting to be sent: what is on screen is
      // ahead of this answer, so it must not be replaced by it.
      if (destroyed || schemaRequest > 0 || pushViews.pending()) return;
      const changed = !same(result.properties, db.properties) || !same(result.views, db.views);
      db.properties = result.properties;
      db.views = result.views;
      // A changed property can drop values (a deleted option, another type).
      // Rows that are being saved right now keep what the user just entered.
      let rowsChanged = false;
      for (const fresh of body.properties ? result.rows : []) {
        const local = db.rows.find((row) => row.id === fresh.id);
        if (local && !rowSaves.get(local.id) && !same(local.props, fresh.props)) {
          local.props = fresh.props;
          rowsChanged = true;
        }
      }
      if (changed || rowsChanged) render();
    } catch (error) {
      schemaRequest = 0;
      toastError(error, 'Could not save the database');
      load();
    }
  }

  // What is sent is read when the request starts, so it is never stale.
  const pushViews = debounce(() => pushSchema(() => ({ views: db.views })), 350);

  function saveProperties(properties) {
    db.properties = properties;
    render();
    pushViews.cancel();
    pushSchema(() => ({ properties: db.properties, views: db.views }));
  }

  function saveProperty(prop) {
    saveProperties(db.properties.map((item) => (item.id === prop.id ? prop : item)));
  }

  /** Change the current view; `full` also redraws the tabs and buttons. */
  function changeView(changes, { full = false } = {}) {
    const view = currentView();
    Object.assign(view, changes);
    if (full) render();
    else renderBody();
    pushViews();
  }

  async function updateRow(row, changes) {
    if (changes.title !== undefined) row.title = changes.title;
    if (changes.props) {
      row.props = { ...row.props };
      for (const [id, value] of Object.entries(changes.props)) {
        if (value === null || value === undefined) delete row.props[id];
        else row.props[id] = value;
      }
    }
    renderBody();
    rowSaves.set(row.id, (rowSaves.get(row.id) ?? 0) + 1);
    try {
      await schemaSaves;
      const saved = await api.patch(`${url}/rows/${row.id}`, changes);
      rowSaves.set(row.id, rowSaves.get(row.id) - 1);
      if (destroyed) return;
      // Only the last answer for a row is the truth; earlier ones are behind.
      if (rowSaves.get(row.id)) return;
      const differs = !same(saved.props, row.props) || saved.title !== row.title;
      Object.assign(row, saved);
      if (changes.title !== undefined) patchPage(row.id, { title: saved.title });
      if (differs) renderBody();
    } catch (error) {
      rowSaves.set(row.id, 0);
      toastError(error, 'Could not save the change');
      load();
    }
  }

  /** Values a new row needs so that it shows up under the current filters. */
  function filterDefaults(view) {
    const props = {};
    for (const rule of view.filter ?? []) {
      const prop = property(rule.property);
      if (!prop) continue;
      if (rule.op === 'checked') props[prop.id] = true;
      else if (rule.op === 'is' && rule.value && (hasOptions(prop) || prop.type === 'person')) {
        props[prop.id] = prop.type === 'person' ? [Number(rule.value)] : rule.value;
      }
    }
    return props;
  }

  async function addRow({ props = {}, beforeId = null, afterId = null, edit = true } = {}) {
    if (!db.can_edit) return null;
    try {
      await schemaSaves;
      const row = await api.post(`${url}/rows`, {
        title: '',
        props: { ...filterDefaults(currentView()), ...props },
        before_id: beforeId,
        after_id: afterId,
      });
      if (destroyed) return null;
      const anchor = beforeId ?? afterId;
      const index = db.rows.findIndex((item) => item.id === anchor);
      if (index < 0) db.rows.push(row);
      else db.rows.splice(beforeId ? index : index + 1, 0, row);
      db.rows.forEach((item, position) => {
        item.position = position + 1;
      });
      if (edit) editTitleOf = row.id;
      renderBody();
      refreshTree();
      return row;
    } catch (error) {
      toastError(error, 'Could not add a row');
      return null;
    }
  }

  async function deleteRow(row) {
    try {
      await api.delete(`/api/pages/${row.id}`);
      if (destroyed) return;
      db.rows = db.rows.filter((item) => item.id !== row.id);
      renderBody();
      refreshTree();
      toast('Moved to the recycle bin', {
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              await api.post(`/api/trash/${row.id}/restore`);
              await load();
              refreshTree();
            } catch (error) {
              toastError(error);
            }
          },
        },
      });
    } catch (error) {
      toastError(error, 'Could not delete the row');
    }
  }

  /** Put `row` before or after another row (manual order). */
  async function moveRow(row, { beforeId = null, afterId = null }) {
    const anchor = beforeId ?? afterId;
    if (anchor === row.id) return;
    const rows = db.rows.filter((item) => item.id !== row.id);
    const index = rows.findIndex((item) => item.id === anchor);
    if (index < 0) rows.push(row);
    else rows.splice(beforeId ? index : index + 1, 0, row);
    rows.forEach((item, position) => {
      item.position = position + 1;
    });
    db.rows = rows;
    renderBody();
    try {
      await api.patch(`${url}/rows/${row.id}`, { before_id: beforeId, after_id: afterId });
    } catch (error) {
      toastError(error, 'Could not move the row');
      load();
    }
  }

  // -- property menus ---------------------------------------------------------------

  function addProperty(anchor) {
    openMenu({
      anchor,
      placement: 'bottom-end',
      items: [
        { heading: 'New property' },
        ...ADDABLE_TYPES.map((type) => ({
          label: TYPES[type].label,
          icon: TYPES[type].icon,
          onSelect: () => {
            const used = new Set(db.properties.map((prop) => prop.name));
            let name = TYPES[type].label;
            for (let n = 2; used.has(name); n += 1) name = `${TYPES[type].label} ${n}`;
            const prop = { id: newId('p'), name, type };
            if (hasOptions(prop)) prop.options = [];
            if (type === 'number') prop.format = 'number';
            saveProperties([...db.properties, prop]);
            const cell = root.querySelector(`[data-header="${prop.id}"]`);
            if (cell) propertyMenu(prop, cell, { rename: true });
          },
        })),
      ],
    });
  }

  function propertyMenu(prop, anchor, { rename = false } = {}) {
    const view = currentView();
    const isTitle = prop.type === 'title';
    const name = h('input', { class: 'input', type: 'text', value: prop.name, 'aria-label': 'Property name', maxLength: 100 });
    const commitName = () => {
      const next = name.value.trim();
      const latest = property(prop.id);
      if (next && latest && next !== latest.name) saveProperty({ ...latest, name: next });
    };
    name.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        popover.close();
      }
    });
    const row = (label, iconName, onClick, { danger = false, hint = null, keep = false } = {}) => {
      const el = h(
        'div',
        { class: `menu-item${danger ? ' is-danger' : ''}`, role: 'menuitem', tabIndex: -1 },
        icon(iconName, 16),
        h('span', { class: 'menu-label' }, label),
        hint ? h('span', { class: 'menu-hint' }, hint) : null,
      );
      el.addEventListener('click', () => {
        if (!keep) popover.close();
        onClick(el);
      });
      return el;
    };
    const setSort = (direction) => changeView({ sort: [{ property: prop.id, direction }] }, { full: true });
    const content = h(
      'div',
      { class: 'menu db-property-menu' },
      h('div', { class: 'db-property-name' }, name),
      isTitle
        ? null
        : row(
            'Type',
            TYPES[prop.type].icon,
            (el) =>
              openMenu({
                anchor: el,
                placement: 'right-start',
                items: ADDABLE_TYPES.map((type) => ({
                  label: TYPES[type].label,
                  icon: TYPES[type].icon,
                  checked: type === prop.type,
                  onSelect: () => {
                    popover.close();
                    if (type === prop.type) return;
                    const latest = property(prop.id);
                    const next = { id: latest.id, name: latest.name, type };
                    if (hasOptions(next)) next.options = latest.options ?? [];
                    if (type === 'number') next.format = 'number';
                    saveProperty(next);
                  },
                })),
              }),
            { hint: TYPES[prop.type].label, keep: true },
          ),
      prop.type === 'number'
        ? row(
            'Show as',
            'hash',
            (el) =>
              openMenu({
                anchor: el,
                placement: 'right-start',
                items: NUMBER_FORMATS.map(([format, label]) => ({
                  label,
                  checked: (prop.format ?? 'number') === format,
                  onSelect: () => {
                    popover.close();
                    saveProperty({ ...property(prop.id), format });
                  },
                })),
              }),
            { hint: NUMBER_FORMATS.find(([format]) => format === (prop.format ?? 'number'))[1], keep: true },
          )
        : null,
      h('div', { class: 'menu-separator' }),
      row('Sort ascending', 'arrow-up', () => setSort('asc')),
      row('Sort descending', 'arrow-down', () => setSort('desc')),
      row('Filter', 'filter', () => {
        const [op] = filterOps(prop)[0];
        changeView({ filter: [...(view.filter ?? []), { property: prop.id, op, value: null }] }, { full: true });
        openFilters(toolbar.querySelector('[data-control="filter"]'));
      }),
      isTitle
        ? null
        : row('Hide in this view', 'eye-off', () =>
            changeView({ hidden: [...new Set([...(view.hidden ?? []), prop.id])] }, { full: true }),
          ),
      isTitle
        ? null
        : row(
            'Delete property',
            'trash-2',
            async () => {
              const sure = await confirmDialog({
                title: `Delete “${prop.name}”?`,
                message: 'The property and its values are removed from every row.',
                confirmLabel: 'Delete',
                danger: true,
              });
              if (sure) saveProperties(db.properties.filter((item) => item.id !== prop.id));
            },
            { danger: true },
          ),
    );
    const popover = openPopover({
      anchor,
      placement: 'bottom-start',
      offset: 2,
      className: 'menu-popover',
      content,
      restoreFocus: false,
      onClose: commitName,
    });
    if (rename) {
      name.focus();
      name.select();
    }
  }

  // -- view menus -------------------------------------------------------------------

  function selectView(id) {
    viewId = id;
    storageSet(viewKey, id);
    render();
  }

  function addView(anchor) {
    const create = (type) => {
      const groupable = db.properties.find((prop) => GROUPABLE.has(prop.type));
      const view = { id: newId('v'), name: type === 'board' ? 'Board' : 'Table', type };
      if (type === 'board') view.groupBy = groupable?.id ?? null;
      db.views = [...db.views, view];
      selectView(view.id);
      pushViews();
    };
    openMenu({
      anchor,
      items: [
        { heading: 'New view' },
        { label: 'Table', icon: 'table', onSelect: () => create('table') },
        { label: 'Board', icon: 'kanban', description: 'Cards in columns, grouped by a property', onSelect: () => create('board') },
      ],
    });
  }

  function viewMenu(view, anchor) {
    const hidden = new Set(view.hidden ?? []);
    openMenu({
      anchor,
      items: [
        {
          label: 'Rename…',
          icon: 'pencil',
          onSelect: async () => {
            const name = await promptDialog({ title: 'Rename view', value: view.name });
            if (name) changeView({ name }, { full: true });
          },
        },
        {
          label: 'Layout',
          icon: VIEW_ICONS[view.type],
          submenu: [
            ['table', 'Table'],
            ['board', 'Board'],
          ].map(([type, label]) => ({
            label,
            icon: VIEW_ICONS[type],
            checked: view.type === type,
            onSelect: () => {
              const groupable = db.properties.find((prop) => GROUPABLE.has(prop.type));
              changeView({ type, groupBy: view.groupBy ?? groupable?.id ?? null }, { full: true });
            },
          })),
        },
        view.type === 'board'
          ? {
              label: 'Group by',
              icon: 'rows',
              submenu: db.properties
                .filter((prop) => GROUPABLE.has(prop.type))
                .map((prop) => ({
                  label: prop.name,
                  icon: TYPES[prop.type].icon,
                  checked: view.groupBy === prop.id,
                  onSelect: () => changeView({ groupBy: prop.id }, { full: true }),
                })),
            }
          : null,
        {
          label: 'Properties',
          icon: 'eye',
          submenu: db.properties
            .filter((prop) => prop.type !== 'title')
            .map((prop) => ({
              label: prop.name,
              icon: TYPES[prop.type].icon,
              checked: !hidden.has(prop.id),
              onSelect: () => {
                const next = new Set(view.hidden ?? []);
                if (next.has(prop.id)) next.delete(prop.id);
                else next.add(prop.id);
                changeView({ hidden: [...next] }, { full: true });
              },
            })),
        },
        { separator: true },
        {
          label: 'Duplicate view',
          icon: 'copy',
          onSelect: () => {
            const copy = { ...JSON.parse(JSON.stringify(view)), id: newId('v'), name: `${view.name} copy` };
            db.views = [...db.views, copy];
            selectView(copy.id);
            pushViews();
          },
        },
        {
          label: 'Delete view',
          icon: 'trash-2',
          danger: true,
          disabled: db.views.length < 2,
          onSelect: () => {
            db.views = db.views.filter((item) => item.id !== view.id);
            selectView(db.views[0].id);
            pushViews();
          },
        },
      ],
    });
  }

  // -- filters and sorts --------------------------------------------------------------

  function choice(options, value, onChange, label) {
    const select = h(
      'select',
      { class: 'select', 'aria-label': label },
      options.map(([key, text]) => h('option', { value: key, selected: String(key) === String(value) }, text)),
    );
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  function rulesPopover(anchor, { title, emptyText, addLabel, rows, add }) {
    const list = h('div', { class: 'db-rules' });
    const draw = () => {
      const items = rows(draw);
      replace(
        list,
        h('div', { class: 'db-rules-title' }, title),
        items.length ? items : h('div', { class: 'db-rules-empty' }, emptyText),
        h(
          'button',
          {
            class: 'button button-ghost button-small db-rules-add',
            type: 'button',
            onclick: (event) =>
              openMenu({
                anchor: event.currentTarget,
                items: db.properties.map((prop) => ({
                  label: prop.name,
                  icon: TYPES[prop.type].icon,
                  onSelect: () => {
                    add(prop);
                    draw();
                  },
                })),
              }),
          },
          icon('plus', 14),
          addLabel,
        ),
      );
    };
    draw();
    openPopover({
      anchor,
      placement: 'bottom-end',
      className: 'db-rules-popover',
      content: list,
      restoreFocus: false,
      onClose: () => {
        if (!destroyed) renderToolbar();
      },
    });
  }

  function filterValue(prop, rule, update) {
    const needsValue = filterOps(prop).find(([op]) => op === rule.op)?.[2];
    if (!needsValue) return null;
    if (hasOptions(prop)) {
      return choice([['', 'Select…'], ...(prop.options ?? []).map((option) => [option.id, option.name])], rule.value ?? '', (value) => update({ value: value || null }), 'Value');
    }
    if (prop.type === 'person') {
      return choice([['', 'Select…'], ...[...store.users].map(([id, name]) => [id, name])], rule.value ?? '', (value) => update({ value: value || null }), 'Value');
    }
    const input = h('input', {
      class: 'input',
      type: prop.type === 'date' ? 'date' : 'text',
      inputMode: prop.type === 'number' ? 'decimal' : null,
      value: rule.value ?? '',
      placeholder: 'Value',
      'aria-label': 'Value',
    });
    input.addEventListener('input', () => {
      const raw = input.value.trim();
      update({ value: raw === '' ? null : prop.type === 'number' ? Number(raw.replace(',', '.')) || 0 : raw }, false);
    });
    return input;
  }

  function openFilters(anchor) {
    if (!anchor) return;
    rulesPopover(anchor, {
      title: 'Show rows where',
      emptyText: 'No filters. Every row is shown.',
      addLabel: 'Add a filter',
      add: (prop) => {
        const [op] = filterOps(prop)[0];
        changeView({ filter: [...(currentView().filter ?? []), { property: prop.id, op, value: null }] });
      },
      rows: (draw) =>
        (currentView().filter ?? []).map((rule, index) => {
          const prop = property(rule.property);
          if (!prop) return null;
          const update = (changes, redraw = true) => {
            const next = [...currentView().filter];
            next[index] = { ...next[index], ...changes };
            changeView({ filter: next });
            if (redraw) draw();
          };
          return h(
            'div',
            { class: 'db-rule' },
            choice(db.properties.map((item) => [item.id, item.name]), prop.id, (id) => {
              const [op] = filterOps(property(id))[0];
              update({ property: id, op, value: null });
            }, 'Property'),
            choice(filterOps(prop).map(([op, label]) => [op, label]), rule.op, (op) => update({ op }), 'Condition'),
            filterValue(prop, rule, update),
            h(
              'button',
              {
                class: 'icon-button',
                type: 'button',
                'aria-label': 'Remove filter',
                title: 'Remove filter',
                onclick: () => {
                  changeView({ filter: currentView().filter.filter((_, i) => i !== index) });
                  draw();
                },
              },
              icon('x', 14),
            ),
          );
        }),
    });
  }

  function openSorts(anchor) {
    rulesPopover(anchor, {
      title: 'Sort by',
      emptyText: 'No sorting. Rows keep the order you give them by dragging.',
      addLabel: 'Add a sort',
      add: (prop) => changeView({ sort: [...(currentView().sort ?? []), { property: prop.id, direction: 'asc' }] }),
      rows: (draw) =>
        (currentView().sort ?? []).map((rule, index) => {
          const update = (changes) => {
            const next = [...currentView().sort];
            next[index] = { ...next[index], ...changes };
            changeView({ sort: next });
            draw();
          };
          return h(
            'div',
            { class: 'db-rule' },
            choice(db.properties.map((item) => [item.id, item.name]), rule.property, (id) => update({ property: id }), 'Property'),
            choice(
              [
                ['asc', 'Ascending'],
                ['desc', 'Descending'],
              ],
              rule.direction,
              (direction) => update({ direction }),
              'Direction',
            ),
            h(
              'button',
              {
                class: 'icon-button',
                type: 'button',
                'aria-label': 'Remove sort',
                title: 'Remove sort',
                onclick: () => {
                  changeView({ sort: currentView().sort.filter((_, i) => i !== index) });
                  draw();
                },
              },
              icon('x', 14),
            ),
          );
        }),
    });
  }

  // -- rendering ----------------------------------------------------------------------

  const saveTitle = debounce(async (value) => {
    try {
      const result = await api.patch(`/api/pages/${databaseId}`, { title: value });
      db.title = result.title;
      patchPage(databaseId, { title: result.title });
    } catch (error) {
      toastError(error, 'Could not rename the database');
    }
  }, 500);

  function renderTitle() {
    if (!inline) {
      titleBar.hidden = true;
      return;
    }
    const input = h('input', {
      class: 'db-title',
      type: 'text',
      value: db.title,
      placeholder: 'New database',
      readOnly: !db.can_edit,
      'aria-label': 'Database name',
      maxLength: 300,
    });
    input.addEventListener('input', () => {
      db.title = input.value;
      saveTitle(input.value);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') input.blur();
    });
    replace(
      titleBar,
      h('span', { class: 'db-title-icon' }, db.icon || icon('database', 18)),
      input,
      h(
        'a',
        { class: 'icon-button db-open', href: pagePath(databaseId), dataset: { link: '' }, title: 'Open as a full page', 'aria-label': 'Open as a full page' },
        icon('maximize', 15),
      ),
    );
  }

  function renderToolbar() {
    const view = currentView();
    const tabs = db.views.map((item) => {
      const active = item.id === view.id;
      const tab = h(
        'button',
        {
          class: `db-tab${active ? ' is-active' : ''}`,
          type: 'button',
          role: 'tab',
          'aria-selected': active ? 'true' : 'false',
          title: active && db.can_edit ? 'View options' : item.name,
        },
        icon(VIEW_ICONS[item.type], 15),
        h('span', null, item.name),
      );
      tab.addEventListener('click', () => {
        if (!active) selectView(item.id);
        else if (db.can_edit) viewMenu(item, tab);
      });
      return tab;
    });
    const control = (name, label, iconName, count, onClick) => {
      const button = h(
        'button',
        {
          class: `db-control${count ? ' is-on' : ''}`,
          type: 'button',
          title: label,
          'aria-label': label,
          dataset: { control: name },
        },
        icon(iconName, 15),
        count ? h('span', null, `${label} · ${count}`) : null,
      );
      button.addEventListener('click', () => onClick(button));
      return button;
    };
    const search = h('input', {
      class: 'db-search',
      type: 'text',
      value: query,
      placeholder: 'Type to search…',
      'aria-label': 'Search this database',
      hidden: !searchOpen && !query,
    });
    search.addEventListener('input', () => {
      query = search.value;
      renderBody();
    });
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        query = '';
        searchOpen = false;
        render();
      }
    });
    replace(
      toolbar,
      h(
        'div',
        { class: 'db-tabs', role: 'tablist' },
        tabs,
        db.can_edit
          ? h(
              'button',
              {
                class: 'db-tab db-tab-add',
                type: 'button',
                title: 'Add a view',
                'aria-label': 'Add a view',
                onclick: (event) => addView(event.currentTarget),
              },
              icon('plus', 15),
            )
          : null,
      ),
      h(
        'div',
        { class: 'db-controls' },
        control('filter', 'Filter', 'filter', (view.filter ?? []).length, openFilters),
        control('sort', 'Sort', 'sort', (view.sort ?? []).length, openSorts),
        control('search', 'Search', 'search', 0, () => {
          searchOpen = true;
          search.hidden = false;
          search.focus();
        }),
        search,
        db.can_edit ? control('view', 'View options', 'more', 0, (button) => viewMenu(view, button)) : null,
        db.can_edit
          ? h(
              'button',
              { class: 'button button-primary button-small db-new', type: 'button', onclick: () => addRow() },
              'New',
            )
          : null,
      ),
    );
  }

  function renderBody() {
    const view = currentView();
    const scroller = body.querySelector('.db-scroll');
    const scroll = scroller ? [scroller.scrollLeft, scroller.scrollTop] : null;
    const editing = editTitleOf;
    editTitleOf = null;
    const context = {
      db,
      view,
      rows: visibleRows(view),
      properties: shownProperties(view),
      canEdit: db.can_edit,
      /** Manual order only makes sense while nothing sorts the rows. */
      sorted: (view.sort ?? []).length > 0,
      editTitleOf: editing,
      property,
      updateRow,
      addRow,
      deleteRow,
      moveRow,
      saveProperty,
      changeView,
      propertyMenu,
      addProperty,
      openRow: (row) => navigate(pagePath(row.id)),
    };
    replace(body, view.type === 'board' ? renderBoard(context) : renderTable(context));
    const next = body.querySelector('.db-scroll');
    if (next && scroll) {
      [next.scrollLeft, next.scrollTop] = scroll;
    }
    body.querySelector('[data-autofocus]')?.focus();
  }

  function render() {
    if (!db || destroyed) return;
    renderTitle();
    renderToolbar();
    renderBody();
  }

  async function load() {
    try {
      const result = await api.get(url);
      if (destroyed) return;
      db = result;
      render();
    } catch (error) {
      if (destroyed) return;
      replace(
        root,
        h(
          'div',
          { class: 'db-missing' },
          icon('database', 18),
          error?.status === 404
            ? 'This database was deleted, or it is not shared with you.'
            : 'The database could not be loaded.',
        ),
      );
    }
  }

  load();
  return {
    reload: load,
    destroy() {
      pushViews.flush();
      saveTitle.flush();
      destroyed = true;
    },
  };
}
