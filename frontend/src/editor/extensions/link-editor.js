// Insert, edit and remove links (Ctrl/Cmd+K), plus a small popover for
// existing links.
import { Extension } from '@tiptap/core';
import { AllSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';

function isTextual(selection) {
  return selection instanceof TextSelection || selection instanceof AllSelection;
}
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { openPopover } from '../../lib/popover.js';
import { normalizeUrl } from '../urls.js';

function selectionRect(view) {
  const { from, to } = view.state.selection;
  const start = view.coordsAtPos(from);
  const end = view.coordsAtPos(to, -1);
  const top = Math.min(start.top, end.top);
  const bottom = Math.max(start.bottom, end.bottom);
  const left = Math.min(start.left, end.left);
  const right = Math.max(start.right, end.right);
  return new DOMRect(left, top, Math.max(right - left, 1), bottom - top);
}

export function openLinkEditor(editor) {
  if (!editor.isEditable || !isTextual(editor.state.selection)) return;
  const { view } = editor;
  const { empty } = editor.state.selection;
  const existing = editor.getAttributes('link').href || '';
  const rect = selectionRect(view);

  const input = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'Paste or type a link…',
    value: existing,
    'aria-label': 'Link address',
    spellcheck: false,
    autocomplete: 'off',
  });
  const error = h('div', { class: 'link-error' });

  function apply() {
    const href = normalizeUrl(input.value);
    if (!href) {
      error.textContent = 'Enter a valid web address';
      input.focus();
      return;
    }
    popover.close({ focus: false });
    const chain = editor.chain().focus();
    if (existing) {
      chain.extendMarkRange('link').setLink({ href }).run();
    } else if (empty) {
      chain
        .insertContent({
          type: 'text',
          text: input.value.trim(),
          marks: [{ type: 'link', attrs: { href } }],
        })
        .run();
    } else {
      chain.setLink({ href }).run();
    }
  }

  function remove() {
    popover.close({ focus: false });
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
  }

  const form = h(
    'form',
    {
      class: 'link-editor',
      onsubmit: (event) => {
        event.preventDefault();
        apply();
      },
    },
    h(
      'div',
      { class: 'link-editor-row' },
      input,
      h('button', { class: 'button button-primary button-small', type: 'submit' }, 'Apply'),
      existing
        ? h(
            'button',
            {
              class: 'icon-button',
              type: 'button',
              title: 'Remove link',
              'aria-label': 'Remove link',
              onclick: remove,
            },
            icon('unlink', 15),
          )
        : null,
    ),
    error,
  );

  const popover = openPopover({
    anchor: () => rect,
    content: form,
    placement: 'bottom-start',
    className: 'link-popover',
    onClose: () => {
      if (!view.isDestroyed && !view.hasFocus() && document.activeElement === document.body) {
        view.focus();
      }
    },
  });
  input.focus();
  input.select();
}

function openLinkPreview(editor, anchor, href) {
  const editButton = h(
    'button',
    {
      class: 'icon-button',
      type: 'button',
      title: 'Edit link',
      'aria-label': 'Edit link',
      onclick: () => {
        popover.close({ focus: false });
        openLinkEditor(editor);
      },
    },
    icon('pencil', 14),
  );
  const content = h(
    'div',
    { class: 'link-preview' },
    h(
      'a',
      { class: 'link-preview-url', href, target: '_blank', rel: 'noopener noreferrer nofollow' },
      icon('external', 14),
      h('span', null, href),
    ),
    editor.isEditable ? editButton : null,
    editor.isEditable
      ? h(
          'button',
          {
            class: 'icon-button',
            type: 'button',
            title: 'Remove link',
            'aria-label': 'Remove link',
            onclick: () => {
              popover.close({ focus: false });
              editor.chain().focus().extendMarkRange('link').unsetLink().run();
            },
          },
          icon('unlink', 14),
        )
      : null,
  );
  const popover = openPopover({
    anchor,
    content,
    placement: 'bottom-start',
    className: 'link-popover',
    restoreFocus: false,
  });
}

export const LinkEditor = Extension.create({
  name: 'linkEditor',

  addKeyboardShortcuts() {
    return {
      // With a selection (or inside a link) Mod+K edits the link. Otherwise
      // the key is left alone and opens the global search.
      'Mod-k': () => {
        const { selection } = this.editor.state;
        if (!isTextual(selection)) return false;
        if (selection.empty && !this.editor.isActive('link')) return false;
        if (this.editor.isActive('codeBlock')) return false;
        openLinkEditor(this.editor);
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('linkClicks'),
        props: {
          handleClick(view, _pos, event) {
            const anchor = event.target.closest?.('a[href]');
            if (!anchor || !view.dom.contains(anchor)) return false;
            const href = anchor.getAttribute('href');
            if (event.ctrlKey || event.metaKey || !editor.isEditable) {
              window.open(href, '_blank', 'noopener,noreferrer');
              return true;
            }
            openLinkPreview(editor, anchor, href);
            return false;
          },
        },
      }),
    ];
  },
});
