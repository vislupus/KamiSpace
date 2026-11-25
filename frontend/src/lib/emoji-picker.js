// The emoji picker: the whole Unicode set, searchable in English and in
// Bulgarian, with the ones used lately on top. The data is part of the
// application (loaded the first time a picker opens); nothing is fetched
// from anywhere else.
import { h } from './dom.js';
import { prepareEmoji, searchEmoji } from './emoji-search.js';
import { supportedEmoji } from './emoji-support.js';
import { openPopover } from './popover.js';
import { storageGet, storageSet } from './util.js';

const RECENT_KEY = 'kamispace-emoji-recent';
const RECENT_MAX = 27;
const COLUMNS = 9;

let loading = null;

/** { groups, all } — every emoji, loaded once. */
export function loadEmoji() {
  loading ??= import('../data/emoji.json').then(async (module) => {
    const data = prepareEmoji(module.default);
    // Only what this computer's fonts can draw (see emoji-support.js).
    const drawable = new Set(await supportedEmoji(data.all));
    return {
      all: data.all.filter((item) => drawable.has(item)),
      groups: data.groups
        .map((group) => ({ ...group, items: group.items.filter((item) => drawable.has(item)) }))
        .filter((group) => group.items.length),
    };
  });
  return loading;
}

export function recentEmoji() {
  const stored = storageGet(RECENT_KEY, []);
  return Array.isArray(stored) ? stored.filter((item) => typeof item === 'string').slice(0, RECENT_MAX) : [];
}

export function rememberEmoji(char) {
  storageSet(RECENT_KEY, [char, ...recentEmoji().filter((item) => item !== char)].slice(0, RECENT_MAX));
}

/**
 * @param {object} options
 * @param {Element|Function|object} options.anchor
 * @param {string|null} [options.current]   the emoji in use: offers "Remove"
 * @param {(emoji: string|null) => void} options.onPick
 * @param {string} [options.placement]
 */
export function openEmojiPicker({ anchor, current = null, onPick, placement = 'bottom-start' }) {
  let data = null;
  const search = h('input', {
    class: 'input emoji-search',
    type: 'text',
    placeholder: 'Search: heart, rocket, сърце…',
    'aria-label': 'Search emoji',
    autocomplete: 'off',
    spellcheck: false,
  });
  const tabs = h('div', { class: 'emoji-tabs', role: 'tablist' });
  const body = h('div', { class: 'emoji-body' }, h('div', { class: 'emoji-note' }, 'Loading…'));
  const status = h('div', { class: 'emoji-status' }, ' ');

  const pick = (value) => {
    if (value) rememberEmoji(value);
    popover.close();
    onPick(value);
  };

  const button = (item) =>
    h('button', { class: 'emoji-button', type: 'button', dataset: { emoji: item.char }, title: item.local ? `${item.name} · ${item.local}` : item.name, 'aria-label': item.name }, item.char);
  const grid = (items) => h('div', { class: 'emoji-grid' }, items.map(button));
  const section = (title, items, key = null) =>
    h('section', { class: 'emoji-section', dataset: key === null ? {} : { group: key } }, h('div', { class: 'emoji-heading' }, title), grid(items));

  function showAll() {
    const byChar = new Map(data.all.map((item) => [item.char, item]));
    const recent = recentEmoji()
      .map((char) => byChar.get(char))
      .filter(Boolean);
    tabs.hidden = false;
    body.replaceChildren(
      ...(recent.length ? [section('Recent', recent)] : []),
      ...data.groups.map((group, index) => section(group.name, group.items, index)),
    );
    body.scrollTop = 0;
  }

  function showResults(query) {
    const found = searchEmoji(data.all, query, 90);
    tabs.hidden = true;
    body.replaceChildren(
      found.length
        ? section(`${found.length === 90 ? 'Best matches' : `${found.length} found`}`, found)
        : h('div', { class: 'emoji-note' }, `Nothing found for “${query.trim()}”. Try another word, in English or Bulgarian.`),
    );
    body.scrollTop = 0;
  }

  const refresh = () => {
    if (!data) return;
    if (search.value.trim()) showResults(search.value);
    else showAll();
  };

  // One listener for all the buttons there are.
  body.addEventListener('click', (event) => {
    const target = event.target.closest('.emoji-button');
    if (target) pick(target.dataset.emoji);
  });
  body.addEventListener('pointerover', (event) => {
    const target = event.target.closest('.emoji-button');
    if (target) status.textContent = `${target.dataset.emoji}  ${target.title}`;
  });
  body.addEventListener('focusin', (event) => {
    const target = event.target.closest('.emoji-button');
    if (target) status.textContent = `${target.dataset.emoji}  ${target.title}`;
  });
  // Arrow keys walk the grid; typing goes back to the search box.
  body.addEventListener('keydown', (event) => {
    const target = event.target.closest('.emoji-button');
    if (!target) return;
    const buttons = [...body.querySelectorAll('.emoji-button')];
    const index = buttons.indexOf(target);
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS }[event.key];
    if (step) {
      event.preventDefault();
      const next = buttons[index + step];
      if (next) next.focus();
      else if (step < 0) search.focus();
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      search.focus();
    }
  });
  search.addEventListener('input', refresh);
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const first = body.querySelector('.emoji-button');
      // With something typed, Enter takes the best match.
      if (first && search.value.trim()) pick(first.dataset.emoji);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      body.querySelector('.emoji-button')?.focus();
    }
  });

  const content = h(
    'div',
    { class: 'emoji-picker' },
    h(
      'div',
      { class: 'emoji-top' },
      search,
      current ? h('button', { class: 'button button-small', type: 'button', onclick: () => pick(null) }, 'Remove') : null,
    ),
    tabs,
    body,
    status,
  );
  const popover = openPopover({ anchor, content, placement, restoreFocus: false });
  search.focus();

  loadEmoji().then(
    (loaded) => {
      data = loaded;
      tabs.replaceChildren(
        ...data.groups.map((group, index) =>
          h(
            'button',
            {
              class: 'emoji-tab',
              type: 'button',
              role: 'tab',
              title: group.name,
              'aria-label': group.name,
              onclick: () => body.querySelector(`[data-group="${index}"]`)?.scrollIntoView({ block: 'start' }),
            },
            group.sample,
          ),
        ),
      );
      refresh();
    },
    () => {
      body.replaceChildren(h('div', { class: 'emoji-note' }, 'The emoji could not be loaded.'));
    },
  );
  return popover;
}
