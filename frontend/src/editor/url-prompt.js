// A small popover at the caret that asks for a web address.
import { h } from '../lib/dom.js';
import { openPopover } from '../lib/popover.js';

/** Make what a person typed into an absolute https address, or null. */
export function normalizeWebUrl(input) {
  const value = (input ?? '').trim();
  if (!value || /\s/.test(value)) return null;
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.')) return null;
    return url.href;
  } catch {
    return null;
  }
}

function caretRect(view) {
  const coords = view.coordsAtPos(view.state.selection.from);
  return new DOMRect(coords.left, coords.top, 1, coords.bottom - coords.top);
}

/** Resolves to the entered address, or null when dismissed. */
export function askForUrl(editor, { placeholder, button = 'Add', hint = '' }) {
  return new Promise((resolve) => {
    let result = null;
    const rect = caretRect(editor.view);
    const input = h('input', {
      class: 'input',
      type: 'text',
      placeholder,
      spellcheck: false,
      autocomplete: 'off',
      'aria-label': placeholder,
    });
    const error = h('div', { class: 'link-error' });
    const form = h(
      'form',
      {
        class: 'link-editor',
        onsubmit: (event) => {
          event.preventDefault();
          const url = normalizeWebUrl(input.value);
          if (!url) {
            error.textContent = 'Enter a valid web address';
            return;
          }
          result = url;
          popover.close({ focus: false });
        },
      },
      h(
        'div',
        { class: 'link-editor-row' },
        input,
        h('button', { class: 'button button-primary button-small', type: 'submit' }, button),
      ),
      hint ? h('div', { class: 'field-hint', style: 'padding: 4px 2px 0' }, hint) : null,
      error,
    );
    const popover = openPopover({
      anchor: () => rect,
      content: form,
      placement: 'bottom-start',
      className: 'link-popover',
      restoreFocus: false,
      onClose: () => {
        if (!editor.isDestroyed) editor.view.focus();
        resolve(result);
      },
    });
    input.focus();
  });
}

/** Insert a block at the caret: replaces an empty line, otherwise goes below. */
export function insertBlockNode(editor, node) {
  const { state, view } = editor;
  const { $from } = state.selection;
  const block = $from.parent;
  const emptyLine = block.type.name === 'paragraph' && block.content.size === 0 && $from.depth > 0;
  const tr = state.tr;
  let pos;
  if (emptyLine) {
    pos = $from.before();
    tr.replaceWith(pos, $from.after(), node);
  } else {
    pos = $from.depth === 0 ? $from.pos : $from.after($from.depth);
    tr.insert(pos, node);
  }
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return pos;
}
