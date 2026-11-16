import { Node, mergeAttributes } from '@tiptap/core';

const FILE_URL = /\/api\/files\/([0-9a-f]{32})/;

export function fileUrl(attachmentId) {
  return `/api/files/${attachmentId}`;
}

/**
 * Image block. Only images uploaded to KamiSpace can be embedded: the node
 * stores an attachment id, never an arbitrary URL, so pages cannot load
 * remote trackers and access control always applies.
 */
export const ImageBlock = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      attachmentId: { default: null },
      alt: { default: null },
      width: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'figure[data-attachment-id]',
        getAttrs: (element) => ({
          attachmentId: element.getAttribute('data-attachment-id'),
          alt: element.querySelector('img')?.getAttribute('alt') || null,
          width: Number(element.getAttribute('data-width')) || null,
        }),
      },
      {
        // Images copied from another KamiSpace page.
        tag: 'img[src]',
        getAttrs: (element) => {
          const match = (element.getAttribute('src') || '').match(FILE_URL);
          return match ? { attachmentId: match[1], alt: element.getAttribute('alt') } : false;
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const { attachmentId, alt, width } = node.attrs;
    return [
      'figure',
      mergeAttributes(HTMLAttributes, {
        class: 'image-block',
        'data-attachment-id': attachmentId,
        'data-width': width || null,
        style: width ? `width: ${width}%` : null,
      }),
      [
        'img',
        {
          src: fileUrl(attachmentId),
          alt: alt || '',
          loading: 'lazy',
          decoding: 'async',
          draggable: 'false',
        },
      ],
    ];
  },

  // Markdown: ![alt](/api/files/<id>). Pictures are lifted out of paragraphs
  // (and foreign addresses turned into links) in editor/markdown.js.
  markdownTokenName: 'image',
  parseMarkdown: (token) => ({ type: 'image', attrs: { src: token.href, alt: token.text } }),
  renderMarkdown: (node) =>
    `![${(node.attrs?.alt ?? '').replace(/[\[\]]/g, '')}](${fileUrl(node.attrs?.attachmentId)})`,

  addCommands() {
    return {
      setImageWidth:
        (width) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, { width }),
    };
  },
});
