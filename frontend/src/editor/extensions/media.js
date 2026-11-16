// Video and audio blocks. The files are uploaded attachments, played by the
// browser's own player straight from the access-controlled file endpoint.
import { Node, createAtomBlockMarkdownSpec, mergeAttributes } from '@tiptap/core';
import { h } from '../../lib/dom.js';
import { fileUrl } from './image.js';

function mediaNode({ name, tag, dataAttribute, className }) {
  return Node.create({
    name,
    group: 'block',
    atom: true,
    selectable: true,
    draggable: true,

    addAttributes() {
      return { attachmentId: { default: null }, name: { default: null } };
    },
    parseHTML() {
      return [
        {
          tag: `div[${dataAttribute}]`,
          getAttrs: (element) => ({
            attachmentId: element.getAttribute('data-attachment-id'),
            name: element.getAttribute('data-name'),
          }),
        },
      ];
    },
    renderHTML({ node, HTMLAttributes }) {
      return [
        'div',
        mergeAttributes(HTMLAttributes, {
          [dataAttribute]: '',
          'data-attachment-id': node.attrs.attachmentId,
          'data-name': node.attrs.name,
        }),
        node.attrs.name ?? '',
      ];
    },
    ...createAtomBlockMarkdownSpec({
      nodeName: name,
      requiredAttributes: ['attachmentId'],
      allowedAttributes: ['attachmentId', 'name'],
    }),

    addNodeView() {
      return ({ node }) => {
        const player = h(tag, {
          src: fileUrl(node.attrs.attachmentId),
          controls: true,
          preload: 'metadata',
          title: node.attrs.name ?? '',
        });
        const dom = h(
          'div',
          { class: className, contentEditable: 'false' },
          tag === 'audio' && node.attrs.name
            ? h('div', { class: 'media-name' }, node.attrs.name)
            : null,
          player,
        );
        return {
          dom,
          update: (updated) =>
            updated.type === node.type && updated.attrs.attachmentId === node.attrs.attachmentId,
          // The player's own controls must keep working inside the editor.
          stopEvent: (event) => player.contains(event.target) && event.type !== 'dragstart',
          ignoreMutation: () => true,
        };
      };
    },
  });
}

export const Video = mediaNode({
  name: 'video',
  tag: 'video',
  dataAttribute: 'data-video',
  className: 'video-block',
});

export const Audio = mediaNode({
  name: 'audio',
  tag: 'audio',
  dataAttribute: 'data-audio',
  className: 'audio-block',
});
