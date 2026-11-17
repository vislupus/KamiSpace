// Slash commands: type "/" to open a searchable block menu. The menu is built
// entirely on the client from the block catalogue — no request is involved.
import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { Suggestion, exitSuggestion } from '@tiptap/suggestion';
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { applyBlock, filterBlocks } from '../blocks.js';
import { createSuggestionRenderer } from './suggestion-menu.js';

export const slashKey = new PluginKey('slashCommands');

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
          return !$from.parent.type.spec.code;
        },
        items: ({ query }) => filterBlocks(query),
        command: ({ editor, range, props: block }) => {
          editor.chain().focus().deleteRange(range).run();
          applyBlock(editor, block);
        },
        render: createSuggestionRenderer({
          className: '',
          emptyText: 'No matching blocks',
          // Sections only make sense for the full list, not for search results.
          groupOf: (item, props) => (props.query ? null : item.group),
          onEscape: (view) => exitSuggestion(view, slashKey),
          renderItem: (item) => [
            h('span', { class: 'slash-icon' }, icon(item.icon, 18)),
            h(
              'span',
              { class: 'slash-text' },
              h('span', { class: 'slash-title' }, item.title),
              h('span', { class: 'slash-description' }, item.description),
            ),
            item.hint ? h('span', { class: 'slash-hint' }, item.hint) : null,
          ],
        }),
      }),
    ];
  },
});
