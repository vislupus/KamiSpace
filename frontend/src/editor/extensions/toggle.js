// Toggles: a summary line that shows or hides the blocks beneath it. With a
// level they are toggle headings (H1–H3). Built on Tiptap's Details nodes;
// the open state is part of the document, so it survives a reload.
//
// The blocks inside a toggle are ordinary blocks: they have their own handle,
// can be dragged in and out, and can be turned into any other block type.
import { InputRule } from '@tiptap/core';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { blockKind, convertBlockInTransaction, currentBlockPos } from '../block-ops.js';

function enclosingToggle($pos, type) {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type === type) return { node: $pos.node(depth), pos: $pos.before(depth), depth };
  }
  return null;
}

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
      // The arrow of the library stores the new state as { open } alone,
      // which drops every other attribute: a toggle heading came back as a
      // plain toggle. The click is handled here instead, keeping them all.
      const arrow = view.dom.querySelector(':scope > button');
      view.dom.addEventListener(
        'click',
        (event) => {
          const { editor, getPos } = props;
          if (!arrow || !arrow.contains(event.target) || !editor.isEditable || typeof getPos !== 'function') return;
          const pos = getPos();
          const node = typeof pos === 'number' ? editor.state.doc.nodeAt(pos) : null;
          if (!node || node.type !== this.type) return;
          event.stopPropagation();
          event.preventDefault();
          const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, open: !node.attrs.open });
          // Closing with the caret inside the body: it moves to the summary.
          const { from } = editor.state.selection;
          if (node.attrs.open && from > pos + node.firstChild.nodeSize && from < pos + node.nodeSize) {
            tr.setSelection(TextSelection.create(tr.doc, pos + 2 + node.firstChild.content.size));
          }
          editor.view.dispatch(tr);
          editor.view.focus();
        },
        true,
      );
      return view;
    };
  },

  addCommands() {
    return {
      ...this.parent?.(),
      /** Turn the current block into a toggle (its text becomes the summary). */
      setToggle:
        (level = 0) =>
        ({ tr, dispatch }) => {
          // Works on the transaction of the surrounding command chain.
          const pos = currentBlockPos(tr);
          const node = tr.doc.nodeAt(pos);
          if (!node || !blockKind(node, tr.doc.resolve(pos).parent)) return false;
          if (!dispatch) return true;
          return convertBlockInTransaction(tr, pos, { kind: 'toggle', level });
        },
    };
  },

  addKeyboardShortcuts() {
    const inherited = this.parent?.() ?? {};
    return {
      ...inherited,
      // Notion's shortcut for a toggle list.
      'Mod-Alt-7': () => this.editor.commands.setToggle(0),
      // Open or close the toggle the caret is in.
      'Mod-Enter': () => {
        const { state, view } = this.editor;
        const found = enclosingToggle(state.selection.$from, this.type);
        if (!found) return false;
        const { node, pos } = found;
        const tr = state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, open: !node.attrs.open });
        if (node.attrs.open) {
          // Closing: keep the caret visible, in the summary.
          tr.setSelection(TextSelection.create(tr.doc, pos + 2 + node.firstChild.content.size));
        }
        view.dispatch(tr);
        return true;
      },
      Enter: (context) => {
        const { state, view } = this.editor;
        const { selection, schema } = state;
        const { $from } = selection;
        // An empty line at the end of a toggle's body: Enter leaves the toggle.
        if (
          selection.empty &&
          $from.depth >= 2 &&
          $from.parent.type.name === 'paragraph' &&
          $from.parent.content.size === 0 &&
          $from.node(-1).type === schema.nodes.detailsContent &&
          $from.index(-1) === $from.node(-1).childCount - 1
        ) {
          const toggleEnd = $from.after($from.depth - 2);
          const tr = state.tr.delete($from.before(), $from.after());
          const at = tr.mapping.map(toggleEnd);
          tr.insert(at, schema.nodes.paragraph.create());
          tr.setSelection(TextSelection.create(tr.doc, at + 1));
          view.dispatch(tr.scrollIntoView());
          return true;
        }
        return inherited.Enter ? inherited.Enter(context) : false;
      },
      Backspace: (context) => {
        const { state, view } = this.editor;
        const { selection, schema } = state;
        const { $from } = selection;
        // An empty first line of the body: Backspace removes it and returns
        // to the summary.
        if (
          selection.empty &&
          $from.depth >= 2 &&
          $from.parentOffset === 0 &&
          $from.parent.type.name === 'paragraph' &&
          $from.parent.content.size === 0 &&
          $from.node(-1).type === schema.nodes.detailsContent &&
          $from.index(-1) === 0
        ) {
          const togglePos = $from.before($from.depth - 2);
          const toggle = $from.node($from.depth - 2);
          const tr = state.tr.delete($from.before(), $from.after());
          tr.setSelection(TextSelection.create(tr.doc, togglePos + 2 + toggle.firstChild.content.size));
          view.dispatch(tr);
          return true;
        }
        return inherited.Backspace ? inherited.Backspace(context) : false;
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

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      ...(this.parent?.() ?? []),
      // Clicking the "Empty toggle" hint starts the first line inside it.
      new Plugin({
        key: new PluginKey('emptyToggle'),
        props: {
          handleClick(view, _pos, event) {
            const body = event.target.closest?.('div[data-type="detailsContent"]');
            if (!editor.isEditable || !body || body.childElementCount > 0) return false;
            const at = view.posAtDOM(body, 0);
            const tr = view.state.tr.insert(at, view.state.schema.nodes.paragraph.create());
            tr.setSelection(TextSelection.create(tr.doc, at + 1));
            view.dispatch(tr);
            view.focus();
            return true;
          },
        },
      }),
    ];
  },
}).configure({ persist: true });

export const ToggleSummary = DetailsSummary.extend({ content: 'inline*' });
// A toggle may be empty ("Empty toggle. Click or drop blocks inside.").
export const ToggleContent = DetailsContent.extend({ content: 'block*' });
