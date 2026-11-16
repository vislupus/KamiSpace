// Block and inline equations, typeset with KaTeX. KaTeX (script, styles and
// fonts) is a separate chunk that is only loaded when a page has an equation.
import { InputRule, Node, mergeAttributes } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { h } from '../../lib/dom.js';
import { openPopover } from '../../lib/popover.js';

let katexPromise = null;

export function loadKatex() {
  katexPromise ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(
    ([module]) => module.default,
  );
  return katexPromise;
}

/** Typeset `latex` into `element`. Errors are shown in place, never thrown. */
export function renderEquation(element, latex, displayMode) {
  element.textContent = latex;
  if (!latex.trim()) return;
  loadKatex().then((katex) => {
    if (!element.isConnected && element.dataset.detached === 'true') return;
    try {
      katex.render(latex, element, {
        displayMode,
        throwOnError: false,
        strict: 'ignore',
        trust: false, // no \href, \includegraphics or raw HTML from documents
      });
    } catch {
      element.textContent = latex;
    }
  });
}

/** Small editor for the TeX source, with a live preview. */
export function openEquationEditor(editor, pos, { displayMode }) {
  const node = editor.state.doc.nodeAt(pos);
  const dom = editor.view.nodeDOM(pos);
  if (!node || !(dom instanceof HTMLElement)) return;
  const original = node.attrs.latex ?? '';

  const input = h('textarea', {
    class: 'textarea equation-input',
    rows: displayMode ? 3 : 1,
    value: original,
    placeholder: displayMode ? '\\int_0^1 x^2 \\, dx = \\frac{1}{3}' : 'E = mc^2',
    spellcheck: false,
    'aria-label': 'TeX source',
  });
  const preview = h('div', { class: 'equation-preview' });
  const refresh = () => renderEquation(preview, input.value, displayMode);
  let cancelled = false;

  function commit() {
    const latex = input.value.trim();
    const current = editor.state.doc.nodeAt(pos);
    if (!current || current.type !== node.type) return;
    if (!latex && !original) {
      // Nothing was ever entered: remove the empty placeholder.
      editor.view.dispatch(editor.state.tr.delete(pos, pos + current.nodeSize));
    } else if (latex !== original) {
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, latex }),
      );
    }
  }

  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (event) => {
    // Enter confirms (Shift+Enter makes a new line in block equations).
    if (event.key === 'Enter' && (!displayMode || !event.shiftKey)) {
      event.preventDefault();
      popover.close();
    }
    if (event.key === 'Escape') cancelled = true;
  });

  const done = h('button', { class: 'button button-primary button-small', type: 'button' }, 'Done');
  done.addEventListener('click', () => popover.close());
  const popover = openPopover({
    anchor: dom,
    placement: 'bottom-start',
    className: 'equation-popover',
    content: h(
      'div',
      { class: 'equation-editor' },
      input,
      preview,
      h(
        'div',
        { class: 'equation-editor-foot' },
        h('span', { class: 'field-hint' }, 'TeX · rendered with KaTeX'),
        done,
      ),
    ),
    restoreFocus: false,
    onClose: () => {
      if (!cancelled || !original) commit();
      if (!editor.isDestroyed) editor.view.focus();
    },
  });
  refresh();
  input.focus();
  input.select();
}

function equationView({ displayMode, tag, className, placeholder }) {
  return ({ node, getPos, editor }) => {
    let current = node;
    const dom = document.createElement(tag);
    dom.className = className;
    dom.contentEditable = 'false';
    const body = document.createElement(displayMode ? 'div' : 'span');
    body.className = 'equation-body';
    dom.append(body);

    const render = () => {
      const latex = current.attrs.latex ?? '';
      dom.classList.toggle('is-empty', !latex.trim());
      if (latex.trim()) renderEquation(body, latex, displayMode);
      else body.textContent = placeholder;
    };
    render();

    dom.addEventListener('click', () => {
      if (!editor.isEditable || typeof getPos !== 'function') return;
      openEquationEditor(editor, getPos(), { displayMode });
    });

    return {
      dom,
      update(updated) {
        if (updated.type !== current.type) return false;
        const changed = updated.attrs.latex !== current.attrs.latex;
        current = updated;
        if (changed) render();
        return true;
      },
      ignoreMutation: () => true,
      destroy() {
        body.dataset.detached = 'true';
      },
    };
  };
}

export const BlockEquation = Node.create({
  name: 'blockEquation',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return { latex: { default: '' } };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-equation]',
        getAttrs: (element) => ({ latex: element.getAttribute('data-latex') ?? '' }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-equation': '', 'data-latex': node.attrs.latex }),
      node.attrs.latex,
    ];
  },
  addNodeView() {
    return equationView({
      displayMode: true,
      tag: 'div',
      className: 'equation-block',
      placeholder: 'Add an equation',
    });
  },
  addCommands() {
    return {
      /** Insert an equation block and open its editor. */
      insertBlockEquation:
        () =>
        ({ editor, state, dispatch }) => {
          const { $from } = state.selection;
          const block = $from.parent;
          const emptyLine = block.type.name === 'paragraph' && block.content.size === 0;
          const pos = emptyLine && $from.depth > 0 ? $from.before() : $from.after(1);
          if (dispatch) {
            const node = this.type.create({ latex: '' });
            const tr = emptyLine
              ? state.tr.replaceWith(pos, pos + block.nodeSize, node)
              : state.tr.insert(pos, node);
            tr.setSelection(NodeSelection.create(tr.doc, pos));
            dispatch(tr);
            requestAnimationFrame(() => openEquationEditor(editor, pos, { displayMode: true }));
          }
          return true;
        },
    };
  },

  // Markdown: $$ … $$ on its own lines.
  markdownTokenizer: {
    name: 'blockEquation',
    level: 'block',
    start: (src) => src.indexOf('$$'),
    tokenize(src) {
      const match = /^\$\$[ \t]*\n?([\s\S]+?)\n?\$\$[ \t]*(?:\n|$)/.exec(src);
      if (!match) return undefined;
      return { type: 'blockEquation', raw: match[0], latex: match[1].trim() };
    },
  },
  parseMarkdown: (token) => ({ type: 'blockEquation', attrs: { latex: token.latex } }),
  renderMarkdown: (node) => `$$\n${node.attrs?.latex ?? ''}\n$$`,
});

export const InlineEquation = Node.create({
  name: 'inlineEquation',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { latex: { default: '' } };
  },
  parseHTML() {
    return [
      {
        tag: 'span[data-inline-equation]',
        getAttrs: (element) => ({ latex: element.getAttribute('data-latex') ?? '' }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-inline-equation': '',
        'data-latex': node.attrs.latex,
      }),
      node.attrs.latex,
    ];
  },
  addNodeView() {
    return equationView({
      displayMode: false,
      tag: 'span',
      className: 'equation-inline',
      placeholder: 'New equation',
    });
  },
  addCommands() {
    return {
      /** Turn the selected text into an inline equation (or start an empty one). */
      setInlineEquation:
        () =>
        ({ editor, state, dispatch }) => {
          const { from, to, $from } = state.selection;
          if ($from.parent.type.spec.code || !$from.parent.inlineContent) return false;
          const latex = state.doc.textBetween(from, to, ' ').trim();
          if (dispatch) {
            dispatch(state.tr.replaceWith(from, to, this.type.create({ latex })));
            if (!latex) {
              requestAnimationFrame(() => openEquationEditor(editor, from, { displayMode: false }));
            }
          }
          return true;
        },
    };
  },
  addKeyboardShortcuts() {
    return { 'Mod-Shift-e': () => this.editor.commands.setInlineEquation() };
  },
  addInputRules() {
    // $$x^2$$ typed in a sentence becomes an inline equation (as in Notion).
    return [
      new InputRule({
        find: /\$\$([^$\n]+)\$\$$/,
        handler: ({ state, range, match }) => {
          // Replace the whole "$$…$$" (delimiters included) with the equation.
          state.tr.replaceWith(range.from, range.to, this.type.create({ latex: match[1].trim() }));
        },
      }),
    ];
  },

  // Markdown: $ … $ inside a line.
  markdownTokenizer: {
    name: 'inlineEquation',
    level: 'inline',
    start: (src) => src.indexOf('$'),
    tokenize(src) {
      const match = /^\$(?!\$)([^$\n]+?)\$(?!\d)/.exec(src);
      if (!match) return undefined;
      return { type: 'inlineEquation', raw: match[0], latex: match[1].trim() };
    },
  },
  parseMarkdown: (token) => ({ type: 'inlineEquation', attrs: { latex: token.latex } }),
  renderMarkdown: (node) => `$${node.attrs?.latex ?? ''}$`,
});
