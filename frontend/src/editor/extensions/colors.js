// Text colour and background highlight. Colours are names, not values: the
// stylesheet decides what "red" looks like in the light and the dark theme.
import { Mark, markInputRule, mergeAttributes } from '@tiptap/core';

export const COLORS = [
  { id: 'gray', label: 'Gray' },
  { id: 'brown', label: 'Brown' },
  { id: 'orange', label: 'Orange' },
  { id: 'yellow', label: 'Yellow' },
  { id: 'green', label: 'Green' },
  { id: 'blue', label: 'Blue' },
  { id: 'purple', label: 'Purple' },
  { id: 'pink', label: 'Pink' },
  { id: 'red', label: 'Red' },
];
const IDS = new Set(COLORS.map((color) => color.id));

function colorAttribute(dataName) {
  return {
    color: {
      default: null,
      parseHTML: (element) => {
        const value = element.getAttribute(dataName);
        return IDS.has(value) ? value : null;
      },
      renderHTML: (attributes) => (attributes.color ? { [dataName]: attributes.color } : {}),
    },
  };
}

export const TextColor = Mark.create({
  name: 'textColor',
  addAttributes: () => colorAttribute('data-text-color'),
  parseHTML() {
    return [{ tag: 'span[data-text-color]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },
  // Colours do not survive Markdown; the text does.
  renderMarkdown: (node, helpers) => helpers.renderChildren(node),
  addCommands() {
    return {
      setTextColor:
        (color) =>
        ({ commands }) =>
          IDS.has(color) ? commands.setMark(this.name, { color }) : commands.unsetMark(this.name),
      unsetTextColor:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});

export const Highlight = Mark.create({
  name: 'highlight',
  addAttributes: () => colorAttribute('data-highlight'),
  parseHTML() {
    return [
      { tag: 'mark[data-highlight]' },
      // Highlights pasted from elsewhere become yellow.
      { tag: 'mark', getAttrs: () => ({ color: 'yellow' }) },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ['mark', mergeAttributes(HTMLAttributes), 0];
  },
  renderMarkdown: (node, helpers) => `==${helpers.renderChildren(node)}==`,
  addCommands() {
    return {
      setHighlight:
        (color = 'yellow') =>
        ({ commands }) =>
          IDS.has(color) ? commands.setMark(this.name, { color }) : commands.unsetMark(this.name),
      unsetHighlight:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
      toggleHighlight:
        (color = 'yellow') =>
        ({ commands }) =>
          commands.toggleMark(this.name, { color }),
    };
  },
  addKeyboardShortcuts() {
    return { 'Mod-Shift-h': () => this.editor.commands.toggleHighlight('yellow') };
  },
  addInputRules() {
    // ==text== → yellow highlight
    return [
      markInputRule({
        find: /(?:^|\s)(==(?!\s+==)((?:[^=]+))==(?!\s+==))$/,
        type: this.type,
        getAttributes: () => ({ color: 'yellow' }),
      }),
    ];
  },
});
