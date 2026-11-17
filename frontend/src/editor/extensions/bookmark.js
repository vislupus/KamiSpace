// Web bookmark: a card with the title and description of a web page.
import { Node, createAtomBlockMarkdownSpec, mergeAttributes } from '@tiptap/core';
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { askForUrl, insertBlockNode } from '../url-prompt.js';
import { appContext } from './app-context.js';

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url ?? '';
  }
}

export const Bookmark = Node.create({
  name: 'bookmark',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return { url: { default: null }, title: { default: null }, description: { default: null } };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-bookmark]',
        getAttrs: (element) => ({
          url: element.getAttribute('data-url'),
          title: element.getAttribute('data-title'),
          description: element.getAttribute('data-description'),
        }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const { url, title, description } = node.attrs;
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-bookmark': '',
        'data-url': url,
        'data-title': title,
        'data-description': description,
      }),
      title || url || '',
    ];
  },
  ...createAtomBlockMarkdownSpec({
    nodeName: 'bookmark',
    requiredAttributes: ['url'],
    allowedAttributes: ['url', 'title', 'description'],
  }),

  addNodeView() {
    return ({ node }) => {
      let current = node;
      const dom = h('div', { class: 'bookmark', contentEditable: 'false' });
      const render = () => {
        const { url, title, description } = current.attrs;
        dom.replaceChildren(
          h(
            'div',
            { class: 'bookmark-main' },
            h(
              'a',
              {
                class: 'bookmark-title',
                href: url,
                target: '_blank',
                rel: 'noopener noreferrer nofollow',
              },
              title || hostOf(url),
            ),
            description ? h('div', { class: 'bookmark-description' }, description) : null,
            h('div', { class: 'bookmark-url' }, icon('link', 12), h('span', null, url ?? '')),
          ),
          h('span', { class: 'bookmark-icon' }, icon('bookmark', 20)),
        );
      };
      render();
      return {
        dom,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated;
          render();
          return true;
        },
        stopEvent: (event) => !!event.target.closest?.('a') && event.type !== 'dragstart',
        ignoreMutation: () => true,
      };
    };
  },
});

/** Ask for an address, insert the card, then fill in title and description. */
export async function promptForBookmark(editor) {
  const url = await askForUrl(editor, {
    placeholder: 'Paste a web address to bookmark…',
    button: 'Bookmark',
  });
  if (!url) return;
  const type = editor.schema.nodes.bookmark;
  insertBlockNode(editor, type.create({ url }));

  const context = appContext(editor);
  if (!context.remoteFetch) return;
  try {
    const preview = await context.fetchBookmark(url);
    if (!preview || editor.isDestroyed) return;
    // The card may have moved meanwhile: find it again by its address.
    let found = null;
    editor.state.doc.descendants((node, pos) => {
      if (found === null && node.type === type && node.attrs.url === url && !node.attrs.title) {
        found = pos;
      }
      return found === null;
    });
    if (found !== null) {
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(found, undefined, {
          url,
          title: preview.title,
          description: preview.description,
        }),
      );
    }
  } catch {
    // No preview available: the card keeps showing the address.
  }
}
