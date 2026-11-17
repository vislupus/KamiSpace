// Embed a web page (or a YouTube / Vimeo video) in a sandboxed frame.
import { Node, createAtomBlockMarkdownSpec, mergeAttributes } from '@tiptap/core';
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { askForUrl, insertBlockNode } from '../url-prompt.js';

/** Known video sites have dedicated player addresses. */
export function embedTarget(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const id = parsed.searchParams.get('v') || parsed.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)/)?.[1];
      if (id) return { src: `https://www.youtube-nocookie.com/embed/${id}`, video: true };
    }
    if (host === 'youtu.be' && parsed.pathname.length > 1) {
      return { src: `https://www.youtube-nocookie.com/embed/${parsed.pathname.slice(1)}`, video: true };
    }
    if (host === 'vimeo.com') {
      const id = parsed.pathname.match(/^\/(\d+)/)?.[1];
      if (id) return { src: `https://player.vimeo.com/video/${id}`, video: true };
    }
    // Frames can only show https pages (the app's policy allows nothing else).
    if (parsed.protocol !== 'https:') return null;
    return { src: parsed.href, video: false };
  } catch {
    return null;
  }
}

export const Embed = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return { url: { default: null }, height: { default: 420 } };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-embed]',
        getAttrs: (element) => ({
          url: element.getAttribute('data-url'),
          height: Number(element.getAttribute('data-height')) || 420,
        }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-embed': '',
        'data-url': node.attrs.url,
        'data-height': node.attrs.height,
      }),
      node.attrs.url ?? '',
    ];
  },
  ...createAtomBlockMarkdownSpec({
    nodeName: 'embed',
    requiredAttributes: ['url'],
    allowedAttributes: ['url', 'height'],
  }),

  addNodeView() {
    return ({ node }) => {
      const { url, height } = node.attrs;
      const target = embedTarget(url ?? '');
      const dom = h('div', { class: 'embed', contentEditable: 'false' });
      const bar = h(
        'div',
        { class: 'embed-bar' },
        icon('globe', 14),
        h('span', { class: 'embed-url' }, url ?? ''),
        h(
          'a',
          {
            class: 'icon-button',
            href: url,
            target: '_blank',
            rel: 'noopener noreferrer nofollow',
            title: 'Open in a new tab',
            'aria-label': 'Open in a new tab',
          },
          icon('external', 14),
        ),
      );
      if (target) {
        const frame = h('iframe', {
          class: `embed-frame${target.video ? ' is-video' : ''}`,
          src: target.src,
          title: url,
          loading: 'lazy',
          referrerPolicy: 'no-referrer',
          allow: 'fullscreen; picture-in-picture; encrypted-media',
          // The framed site runs in its own origin and cannot touch this app.
          sandbox: 'allow-scripts allow-same-origin allow-popups allow-forms allow-presentation',
        });
        if (!target.video) frame.style.height = `${height}px`;
        dom.append(frame, bar);
      } else {
        dom.append(
          h('div', { class: 'embed-blocked' }, 'Only https pages can be embedded.'),
          bar,
        );
      }
      return {
        dom,
        update: (updated) =>
          updated.type === node.type && updated.attrs.url === url && updated.attrs.height === height,
        stopEvent: (event) => !!event.target.closest?.('a') && event.type !== 'dragstart',
        ignoreMutation: () => true,
      };
    };
  },

  addCommands() {
    return {
      insertEmbed:
        (url) =>
        ({ editor }) => {
          if (!embedTarget(url)) return false;
          insertBlockNode(editor, this.type.create({ url }));
          return true;
        },
    };
  },
});

export async function promptForEmbed(editor) {
  const url = await askForUrl(editor, {
    placeholder: 'Paste a web address to embed…',
    button: 'Embed',
    hint: 'Works for pages that allow embedding, YouTube and Vimeo.',
  });
  if (url) editor.commands.insertEmbed(url);
}
