// Emoji in the text, as in Notion: type ":" and a few letters of a name
// (":rocket", ":сърце") and pick from the list at the caret, finish a
// shortcode with a second colon (":fire:"), or use /emoji for the whole
// picker. The emoji is ordinary text in the document.
import { Extension, InputRule } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { Suggestion, exitSuggestion } from '@tiptap/suggestion';
import { h } from '../../lib/dom.js';
import { loadEmoji, openEmojiPicker, rememberEmoji } from '../../lib/emoji-picker.js';
import { searchEmoji } from '../../lib/emoji-search.js';
import { createSuggestionRenderer } from './suggestion-menu.js';

const emojiKey = new PluginKey('emojiSuggestion');
/** Letters, digits, "_", "+" and "-": two at least, so ":)" and "10:30" stay as typed. */
const NAME = /^[\p{L}\p{N}_+-]{2,}$/u;

/** The emoji data once it is there (the list in the text never waits for it twice). */
let ready = null;
const load = () =>
  loadEmoji().then((data) => {
    ready = data;
    return data;
  });

/** Open the full picker at the caret and insert what is chosen. */
export function insertEmoji(editor) {
  const { view } = editor;
  const caret = () => {
    const at = view.coordsAtPos(view.state.selection.from);
    return new DOMRect(at.left, at.top, 0, at.bottom - at.top);
  };
  openEmojiPicker({
    anchor: caret,
    onPick: (emoji) => {
      if (emoji && !editor.isDestroyed) editor.chain().focus().insertContent(emoji).run();
    },
  });
}

export const Emoji = Extension.create({
  name: 'emoji',

  addInputRules() {
    return [
      // ":fire:" becomes 🔥 when the closing colon is typed.
      new InputRule({
        find: /(?:^|\s)(:([a-z0-9_+-]{2,}):)$/,
        handler: ({ state, range, match }) => {
          const found = ready?.all.find((item) => item.code === match[2]);
          if (!found) {
            // Not loaded yet, or not a shortcode: the text stays as typed.
            load();
            return null;
          }
          // The closing colon is in the document by now: ":fire:" ends at range.to.
          state.tr.insertText(found.char, range.to - match[1].length, range.to);
          return undefined;
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: emojiKey,
        char: ':',
        allowSpaces: false,
        // Only at the start of a word: "note: text" and "10:30" open nothing.
        allowedPrefixes: [' ', '('],
        allow: ({ state, range }) => {
          if (state.doc.resolve(range.from).parent.type.spec.code) return false;
          return NAME.test(state.doc.textBetween(range.from, range.to).slice(1));
        },
        items: async ({ query }) => {
          if (!NAME.test(query)) return [];
          const data = ready ?? (await load());
          return searchEmoji(data.all, query, 8);
        },
        command: ({ editor, range, props: item }) => {
          rememberEmoji(item.char);
          editor.chain().focus().insertContentAt(range, item.char).run();
        },
        render: createSuggestionRenderer({
          className: 'emoji-menu',
          emptyText: 'No emoji with that name',
          onEscape: (view) => exitSuggestion(view, emojiKey),
          renderItem: (item) => [
            h('span', { class: 'slash-icon' }, item.char),
            h(
              'span',
              { class: 'slash-text' },
              h('span', { class: 'slash-title' }, item.local || item.name),
              h('span', { class: 'slash-description' }, item.local ? item.name : item.code ? `:${item.code}:` : ''),
            ),
            item.code ? h('span', { class: 'slash-hint' }, `:${item.code}:`) : null,
          ],
        }),
      }),
    ];
  },
});
