// Slash commands: type "/" to open a searchable block menu. The menu is built
// entirely on the client from the block catalogue — no request is involved.
import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { Suggestion, exitSuggestion } from '@tiptap/suggestion';
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { positionElement } from '../../lib/popover.js';
import { applyBlock, filterBlocks } from '../blocks.js';

export const slashKey = new PluginKey('slashCommands');

function createRenderer() {
  let el = null;
  let list = null;
  let items = [];
  let active = 0;
  let props = null;

  function select(index) {
    const item = items[index];
    if (item) props.command(item);
  }

  function highlight(index) {
    active = index;
    [...list.children].forEach((child, i) => child.classList.toggle('is-active', i === active));
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  }

  function render() {
    list.replaceChildren(
      ...(items.length
        ? items.map((item, index) => {
            const row = h(
              'div',
              {
                class: `slash-item${index === active ? ' is-active' : ''}`,
                role: 'option',
                dataset: { command: item.id },
              },
              h('span', { class: 'slash-icon' }, icon(item.icon, 18)),
              h(
                'span',
                { class: 'slash-text' },
                h('span', { class: 'slash-title' }, item.title),
                h('span', { class: 'slash-description' }, item.description),
              ),
              item.hint ? h('span', { class: 'slash-hint' }, item.hint) : null,
            );
            // mousedown, not click: the editor must keep its selection.
            row.addEventListener('mousedown', (event) => {
              event.preventDefault();
              select(index);
            });
            row.addEventListener('mousemove', () => {
              if (active !== index) highlight(index);
            });
            return row;
          })
        : [h('div', { class: 'slash-empty' }, 'No matching blocks')]),
    );
  }

  function place() {
    if (el && props?.clientRect) positionElement(el, props.clientRect, 'bottom-start', 6);
  }

  return {
    onStart(next) {
      props = next;
      items = next.items;
      active = 0;
      list = h('div', { class: 'slash-list', role: 'listbox' });
      el = h('div', { class: 'popover slash-menu' }, list);
      document.body.append(el);
      render();
      place();
    },
    onUpdate(next) {
      props = next;
      items = next.items;
      active = 0;
      render();
      place();
    },
    onKeyDown({ event, view }) {
      if (event.key === 'ArrowDown') {
        if (items.length) highlight((active + 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        if (items.length) highlight((active - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (!items.length) return false;
        select(active);
        return true;
      }
      if (event.key === 'Escape') {
        exitSuggestion(view, slashKey);
        return true;
      }
      return false;
    },
    onExit() {
      el?.remove();
      el = null;
      list = null;
      props = null;
    },
  };
}

export const SlashCommands = Extension.create({
  name: 'slashCommands',

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: slashKey,
        char: '/',
        allowSpaces: false,
        // "/" only opens the menu at the start of a block or after a space,
        // so "and/or" and URLs stay plain text.
        allowedPrefixes: [' '],
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          return $from.parent.type.name !== 'codeBlock' && !$from.parent.type.spec.code;
        },
        items: ({ query }) => filterBlocks(query).slice(0, 14),
        command: ({ editor, range, props: block }) => {
          editor.chain().focus().deleteRange(range).run();
          applyBlock(editor, block);
        },
        render: createRenderer,
      }),
    ];
  },
});
