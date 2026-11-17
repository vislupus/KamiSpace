// Links, the way Notion handles them:
//   - hovering a link shows a small card with its address (copy, edit, remove)
//   - clicking a link opens it
//   - Ctrl/Cmd+K edits the link of the selection and suggests pages to link to
//   - pasting a web address offers to keep it as a link, or turn it into a
//     bookmark or an embed
import { Extension, getMarkRange } from '@tiptap/core';
import { AllSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { copyText } from '../../lib/clipboard.js';
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { openMenu } from '../../lib/menu.js';
import { hasOpenPopover, openPopover, positionElement } from '../../lib/popover.js';
import { toast } from '../../lib/toast.js';
import { normalizeUrl } from '../urls.js';
import { normalizeWebUrl } from '../url-prompt.js';
import { appContext } from './app-context.js';
import { insertBookmark } from './bookmark.js';
import { embedTarget } from './embed.js';

const PAGE_PATH = /^\/p\/(\d+)\/?$/;
const HOVER_DELAY = 280;
const LEAVE_DELAY = 180;
const SUGGESTIONS = 6;

function isTextual(selection) {
  return selection instanceof TextSelection || selection instanceof AllSelection;
}

/** The page a link points at, when it is a link to a page of this workspace. */
function linkedPageId(href) {
  if (!href) return null;
  let path = href;
  if (href.startsWith(location.origin)) path = href.slice(location.origin.length);
  const match = PAGE_PATH.exec(path);
  return match ? Number(match[1]) : null;
}

function absoluteUrl(href) {
  try {
    return new URL(href, location.origin).href;
  } catch {
    return href;
  }
}

function followLink(editor, href) {
  const pageId = linkedPageId(href);
  const context = appContext(editor);
  if (pageId && context.getPage(pageId)) {
    context.openPage(pageId);
    return;
  }
  window.open(href, '_blank', 'noopener,noreferrer');
}

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

/** Select the whole link that `anchor` (an <a> in the document) belongs to. */
function selectLink(editor, anchor) {
  const { view, state } = editor;
  let pos;
  try {
    pos = view.posAtDOM(anchor, 0);
  } catch {
    return false;
  }
  const range = getMarkRange(state.doc.resolve(pos), state.schema.marks.link);
  if (!range) return false;
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, range.from, range.to)));
  return true;
}

export function openLinkEditor(editor) {
  if (!editor.isEditable || !isTextual(editor.state.selection)) return;
  const { view } = editor;
  const { empty } = editor.state.selection;
  const existing = editor.getAttributes('link').href || '';
  const rect = selectionRect(view);
  const context = appContext(editor);
  let matches = [];
  let active = -1;

  const input = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'Paste a link or search pages…',
    value: existing,
    'aria-label': 'Link address',
    spellcheck: false,
    autocomplete: 'off',
  });
  const error = h('div', { class: 'link-error' });
  const suggestions = h('div', { class: 'link-suggestions', role: 'listbox' });

  function setLink(href, text) {
    popover.close({ focus: false });
    const chain = editor.chain().focus();
    if (existing) {
      chain.extendMarkRange('link').setLink({ href }).run();
    } else if (empty) {
      chain.insertContent({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }).run();
    } else {
      chain.setLink({ href }).run();
    }
  }

  function apply() {
    if (active >= 0 && matches[active]) {
      const target = matches[active];
      setLink(`/p/${target.id}`, target.title || 'Untitled');
      return;
    }
    const href = normalizeUrl(input.value);
    if (!href) {
      error.textContent = 'Enter a valid web address';
      input.focus();
      return;
    }
    setLink(href, input.value.trim());
  }

  function remove() {
    popover.close({ focus: false });
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
  }

  function renderSuggestions() {
    const query = input.value.trim().toLowerCase();
    const looksLikeAddress = /^(https?:|mailto:|tel:|\/|#|www\.)/i.test(query) || /\.\w{2,}/.test(query);
    matches =
      query && !looksLikeAddress
        ? context
            .listPages()
            .filter((item) => item.id !== context.pageId)
            .filter((item) => (item.title || 'Untitled').toLowerCase().includes(query))
            .slice(0, SUGGESTIONS)
        : [];
    if (active >= matches.length) active = matches.length - 1;
    if (matches.length && active < 0) active = 0;
    if (!matches.length) active = -1;
    suggestions.replaceChildren(
      ...(matches.length ? [h('div', { class: 'menu-heading' }, 'Link to page')] : []),
      ...matches.map((item, index) => {
        const row = h(
          'div',
          {
            class: `link-suggestion${index === active ? ' is-active' : ''}`,
            role: 'option',
            'aria-selected': index === active ? 'true' : 'false',
          },
          h('span', { class: 'mention-icon' }, item.icon || icon('file-text', 15)),
          h('span', { class: 'link-suggestion-title' }, item.title || 'Untitled'),
        );
        row.addEventListener('mousedown', (event) => event.preventDefault());
        row.addEventListener('click', () => {
          active = index;
          apply();
        });
        return row;
      }),
    );
    popover?.reposition();
  }

  input.addEventListener('input', () => {
    error.textContent = '';
    renderSuggestions();
  });
  input.addEventListener('keydown', (event) => {
    if (!matches.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + matches.length) % matches.length;
      renderSuggestions();
    }
  });

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
    suggestions,
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

// -- hover card ----------------------------------------------------------------

function createHoverCard(editor) {
  let card = null;
  let anchor = null;
  let showTimer = 0;
  let hideTimer = 0;

  function hide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    card?.remove();
    card = null;
    anchor = null;
  }

  function button(label, iconName, onClick) {
    const el = h(
      'button',
      { class: 'icon-button', type: 'button', title: label, 'aria-label': label },
      icon(iconName, 14),
    );
    el.addEventListener('mousedown', (event) => event.preventDefault());
    el.addEventListener('click', onClick);
    return el;
  }

  function show(target) {
    hide();
    if (editor.isDestroyed || !target.isConnected || hasOpenPopover()) return;
    anchor = target;
    const href = target.getAttribute('href');
    const pageId = linkedPageId(href);
    const linkedPage = pageId ? appContext(editor).getPage(pageId) : null;
    const open = h(
      'a',
      {
        class: 'link-preview-url',
        href,
        target: linkedPage ? null : '_blank',
        rel: 'noopener noreferrer nofollow',
        title: 'Open link',
      },
      linkedPage
        ? h('span', { class: 'mention-icon' }, linkedPage.icon || icon('file-text', 14))
        : icon('globe', 14),
      h('span', null, linkedPage ? linkedPage.title || 'Untitled' : href),
    );
    open.addEventListener('click', (event) => {
      event.preventDefault();
      hide();
      followLink(editor, href);
    });
    card = h(
      'div',
      { class: 'popover link-popover link-hover', role: 'tooltip' },
      h(
        'div',
        { class: 'link-preview' },
        open,
        button('Copy link', 'copy', async () => {
          const copied = await copyText(absoluteUrl(href));
          toast(copied ? 'Link copied' : 'Could not copy the link', copied ? {} : { type: 'error' });
          hide();
        }),
        editor.isEditable
          ? button('Edit link', 'pencil', () => {
              const target = anchor;
              hide();
              if (target && selectLink(editor, target)) openLinkEditor(editor);
            })
          : null,
        editor.isEditable
          ? button('Remove link', 'unlink', () => {
              const target = anchor;
              hide();
              if (target && selectLink(editor, target)) {
                editor.chain().focus().unsetLink().run();
              }
            })
          : null,
      ),
    );
    card.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    card.addEventListener('mouseleave', scheduleHide);
    document.body.append(card);
    positionElement(card, target, 'bottom-start', 4);
  }

  function scheduleHide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, LEAVE_DELAY);
  }

  return {
    hide,
    over(target) {
      clearTimeout(hideTimer);
      if (target === anchor) return;
      clearTimeout(showTimer);
      showTimer = setTimeout(() => show(target), HOVER_DELAY);
    },
    out: scheduleHide,
  };
}

// -- pasting an address ----------------------------------------------------------

function caretRect(view) {
  const coords = view.coordsAtPos(view.state.selection.from);
  return new DOMRect(coords.left, coords.top, 1, coords.bottom - coords.top);
}

/** After a pasted address became a link: offer the other shapes it can take. */
function offerPasteChoices(editor, text, url, from, to) {
  const { view } = editor;
  const rect = caretRect(view);

  const replaceWith = (insert) => {
    const { state } = editor;
    // Only when the pasted address is still where it was put.
    if (to > state.doc.content.size || state.doc.textBetween(from, to) !== text) return;
    view.dispatch(state.tr.delete(from, to));
    insert();
  };

  const menu = openMenu({
    anchor: () => rect,
    className: 'paste-menu',
    items: [
      { heading: 'Paste as' },
      { label: 'URL', icon: 'link', onSelect: () => view.focus() },
      {
        label: 'Bookmark',
        icon: 'bookmark',
        description: 'A card with the page title',
        onSelect: () => replaceWith(() => insertBookmark(editor, url)),
      },
      embedTarget(url)
        ? {
            label: 'Embed',
            icon: 'embed',
            description: 'Show the page inside this one',
            onSelect: () => replaceWith(() => editor.commands.insertEmbed(url)),
          }
        : null,
    ],
    onClose: () => {
      if (!view.isDestroyed && document.activeElement === document.body) view.focus();
    },
  });
  menu.focusFirst();
  // Carrying on typing dismisses the menu and keeps the link.
  // (Capture phase: a space would otherwise pick the highlighted entry.)
  menu.el.addEventListener(
    'keydown',
    (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      menu.close();
      view.focus();
      view.dispatch(view.state.tr.insertText(event.key));
    },
    true,
  );
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
        if (selection.empty) this.editor.commands.extendMarkRange('link');
        openLinkEditor(this.editor);
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const hover = createHoverCard(editor);
    return [
      new Plugin({
        key: new PluginKey('linkClicks'),
        view: () => ({ destroy: hover.hide }),
        props: {
          handleClick(view, _pos, event) {
            const anchor = event.target.closest?.('a[href]');
            if (!anchor || !view.dom.contains(anchor) || event.button !== 0) return false;
            if (anchor.closest('.page-link, .page-mention, .bookmark, .attachment')) return false;
            hover.hide();
            followLink(editor, anchor.getAttribute('href'));
            return true;
          },
          handleKeyDown() {
            hover.hide();
            return false;
          },
          handlePaste(view, event) {
            if (!editor.isEditable) return false;
            const { selection } = view.state;
            if (!selection.empty || !(selection instanceof TextSelection)) return false;
            if (selection.$from.parent.type.spec.code) return false;
            const data = event.clipboardData;
            const text = data?.getData('text/plain')?.trim();
            if (!text || !/^https?:\/\/\S+$/i.test(text)) return false;
            if (text.startsWith(location.origin)) return false; // page links: see page-link.js
            // Copied from a page (a link with its own text): keep that text.
            const html = data.getData('text/html');
            if (html && /<a\b/i.test(html) && !html.includes(`>${text}<`)) return false;
            const url = normalizeWebUrl(text);
            const linkType = view.state.schema.marks.link;
            if (!url || !selection.$from.parent.type.allowsMarkType(linkType)) return false;

            event.preventDefault();
            const from = selection.from;
            const tr = view.state.tr.insertText(text, from);
            tr.addMark(from, from + text.length, linkType.create({ href: url }));
            tr.removeStoredMark(linkType);
            view.dispatch(tr.scrollIntoView());
            offerPasteChoices(editor, text, url, from, from + text.length);
            return true;
          },
          handleDOMEvents: {
            mouseover(view, event) {
              const anchor = event.target.closest?.('a[href]');
              if (
                anchor &&
                view.dom.contains(anchor) &&
                !anchor.closest('.page-link, .page-mention, .bookmark, .attachment') &&
                !event.buttons
              ) {
                hover.over(anchor);
              }
              return false;
            },
            mouseout(_view, event) {
              if (event.target.closest?.('a[href]')) hover.out();
              return false;
            },
            mousedown() {
              hover.hide();
              return false;
            },
          },
        },
      }),
    ];
  },
});
