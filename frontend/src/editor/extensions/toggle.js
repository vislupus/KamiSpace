// Toggles: a summary line that shows or hides the blocks beneath it. With a
// level they are toggle headings (H1–H3). Built on Tiptap's Details nodes;
// the open state is part of the document, so it survives a reload.
import { InputRule } from '@tiptap/core';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { TextSelection } from '@tiptap/pm/state';

export const Toggle = Details.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      level: {
        default: 0,
        parseHTML: (element) => Number(element.getAttribute('data-level')) || 0,
        renderHTML: (attributes) => ({ 'data-level': attributes.level || 0 }),
      },
    };
  },

  addNodeView() {
    const createView = this.parent?.();
    return (props) => {
      const view = createView(props);
      view.dom.dataset.level = String(props.node.attrs.level || 0);
      const update = view.update;
      view.update = (node, ...rest) => {
        const handled = update(node, ...rest);
        if (handled) view.dom.dataset.level = String(node.attrs.level || 0);
        return handled;
      };
      return view;
    };
  },

  addCommands() {
    return {
      ...this.parent?.(),
      /**
       * Turn the current text block into a toggle whose summary is that text.
       * Inside an existing toggle only the heading level changes.
       */
      setToggle:
        (level = 0) =>
        ({ state, dispatch }) => {
          const { schema, selection } = state;
          const { $from } = selection;
          for (let depth = $from.depth; depth > 0; depth -= 1) {
            if ($from.node(depth).type === this.type) {
              if (dispatch) {
                const pos = $from.before(depth);
                dispatch(
                  state.tr.setNodeMarkup(pos, undefined, { ...$from.node(depth).attrs, level }),
                );
              }
              return true;
            }
          }
          const block = $from.parent;
          if (!block.isTextblock || $from.depth === 0) return false;
          const container = $from.node(-1);
          const index = $from.index(-1);
          if (!container.canReplaceWith(index, index + 1, this.type)) return false;
          if (dispatch) {
            const summaryContent = block.type.spec.code
              ? block.textContent
                ? schema.text(block.textContent)
                : undefined
              : block.content;
            const node = this.type.create({ open: true, level }, [
              schema.nodes.detailsSummary.create(null, summaryContent),
              schema.nodes.detailsContent.create(null, schema.nodes.paragraph.create()),
            ]);
            const pos = $from.before();
            const tr = state.tr.replaceWith(pos, pos + block.nodeSize, node);
            // Caret at the end of the summary.
            const summaryEnd = pos + 2 + node.firstChild.content.size;
            tr.setSelection(TextSelection.create(tr.doc, summaryEnd));
            dispatch(tr.scrollIntoView());
          }
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      // Notion's shortcut for a toggle list.
      'Mod-Alt-7': () => this.editor.commands.setToggle(0),
      // Open or close the toggle the caret is in.
      'Mod-Enter': () => {
        const { state, view } = this.editor;
        const { $from } = state.selection;
        for (let depth = $from.depth; depth > 0; depth -= 1) {
          const node = $from.node(depth);
          if (node.type === this.type) {
            const pos = $from.before(depth);
            const tr = state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, open: !node.attrs.open });
            if (node.attrs.open) {
              // Closing: keep the caret visible, in the summary.
              tr.setSelection(TextSelection.create(tr.doc, pos + 2 + node.firstChild.content.size));
            }
            view.dispatch(tr);
            return true;
          }
        }
        return false;
      },
    };
  },

  addInputRules() {
    // ">> " at the start of a block starts a toggle ("> " stays a quote).
    return [
      new InputRule({
        find: /^>>\s$/,
        handler: ({ range, chain }) => {
          chain().deleteRange(range).setToggle(0).run();
        },
      }),
    ];
  },
}).configure({ persist: true });

export const ToggleSummary = DetailsSummary.extend({ content: 'inline*' });
export const ToggleContent = DetailsContent;
