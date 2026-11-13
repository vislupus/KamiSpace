import { Node, mergeAttributes } from '@tiptap/core';

export const CALLOUT_VARIANTS = [
  { id: 'info', emoji: '💡', label: 'Info' },
  { id: 'success', emoji: '✅', label: 'Success' },
  { id: 'warning', emoji: '⚠️', label: 'Warning' },
  { id: 'danger', emoji: '⛔', label: 'Danger' },
  { id: 'note', emoji: '📝', label: 'Note' },
];

function variantOf(id) {
  return CALLOUT_VARIANTS.find((variant) => variant.id === id) ?? CALLOUT_VARIANTS[0];
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      variant: {
        default: 'info',
        parseHTML: (element) => element.getAttribute('data-variant') || 'info',
        renderHTML: (attributes) => ({ 'data-variant': attributes.variant }),
      },
      emoji: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-emoji'),
        renderHTML: (attributes) => (attributes.emoji ? { 'data-emoji': attributes.emoji } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const emoji = node.attrs.emoji || variantOf(node.attrs.variant).emoji;
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-callout': '', class: 'callout' }),
      ['span', { class: 'callout-icon', contenteditable: 'false' }, emoji],
      ['div', { class: 'callout-content' }, 0],
    ];
  },

  addCommands() {
    return {
      setCallout:
        (attributes) =>
        ({ commands }) =>
          commands.wrapIn(this.name, attributes),
      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    };
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.className = 'callout';
      dom.dataset.callout = '';

      const iconButton = document.createElement('button');
      iconButton.type = 'button';
      iconButton.className = 'callout-icon';
      iconButton.contentEditable = 'false';
      iconButton.title = 'Change callout style';

      const contentDOM = document.createElement('div');
      contentDOM.className = 'callout-content';
      dom.append(iconButton, contentDOM);

      const render = () => {
        const variant = variantOf(current.attrs.variant);
        dom.dataset.variant = variant.id;
        iconButton.textContent = current.attrs.emoji || variant.emoji;
        iconButton.disabled = !editor.isEditable;
      };
      render();

      // Clicking the icon cycles through the styles.
      iconButton.addEventListener('mousedown', (event) => event.preventDefault());
      iconButton.addEventListener('click', () => {
        if (!editor.isEditable || typeof getPos !== 'function') return;
        const index = CALLOUT_VARIANTS.findIndex((v) => v.id === current.attrs.variant);
        const next = CALLOUT_VARIANTS[(index + 1) % CALLOUT_VARIANTS.length];
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(getPos(), undefined, {
            ...current.attrs,
            variant: next.id,
            emoji: null,
          }),
        );
      });

      return {
        dom,
        contentDOM,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated;
          render();
          return true;
        },
        ignoreMutation(mutation) {
          if (mutation.type === 'selection') return false;
          return !contentDOM.contains(mutation.target);
        },
        stopEvent(event) {
          return iconButton.contains(event.target);
        },
      };
    };
  },
});
