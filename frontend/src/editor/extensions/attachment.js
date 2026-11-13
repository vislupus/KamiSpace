import { Node, mergeAttributes } from '@tiptap/core';
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { fileExtension, formatBytes } from '../../lib/util.js';
import { fileUrl } from './image.js';

function iconFor(name, mime) {
  const extension = fileExtension(name);
  if (mime?.startsWith('image/')) return 'file-image';
  if (['xls', 'xlsx', 'ods', 'csv'].includes(extension)) return 'file-sheet';
  if (['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'markdown'].includes(extension)) {
    return 'file-text';
  }
  return 'file';
}

/** File attachment block: name, type, size, download — and a PDF preview. */
export const Attachment = Node.create({
  name: 'attachment',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      attachmentId: { default: null },
      name: { default: 'file' },
      size: { default: 0 },
      mime: { default: '' },
      preview: { default: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-attachment]',
        getAttrs: (element) => ({
          attachmentId: element.getAttribute('data-attachment-id'),
          name: element.getAttribute('data-name') || 'file',
          size: Number(element.getAttribute('data-size')) || 0,
          mime: element.getAttribute('data-mime') || '',
          preview: element.hasAttribute('data-preview'),
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const { attachmentId, name, size, mime, preview } = node.attrs;
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-attachment': '',
        'data-attachment-id': attachmentId,
        'data-name': name,
        'data-size': size,
        'data-mime': mime,
        'data-preview': preview ? '' : null,
      }),
      name,
    ];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = h('div', { class: 'attachment', contentEditable: 'false' });
      let frame = null;

      const setPreview = (preview) => {
        if (editor.isEditable && typeof getPos === 'function') {
          editor.view.dispatch(
            editor.state.tr.setNodeMarkup(getPos(), undefined, { ...current.attrs, preview }),
          );
        } else {
          // Read-only pages can still toggle the preview locally.
          current = current.type.create({ ...current.attrs, preview });
          render();
        }
      };

      function render() {
        const { attachmentId, name, size, mime, preview } = current.attrs;
        const isPdf = mime === 'application/pdf' || fileExtension(name) === 'pdf';
        const extension = fileExtension(name).toUpperCase() || 'FILE';
        const url = fileUrl(attachmentId);

        const row = h(
          'div',
          { class: 'attachment-row' },
          h('span', { class: 'attachment-icon' }, icon(iconFor(name, mime), 20)),
          h(
            'div',
            { class: 'attachment-main' },
            h('div', { class: 'attachment-name', title: name }, name),
            h('div', { class: 'attachment-meta' }, `${extension} · ${formatBytes(size)}`),
          ),
          isPdf
            ? h(
                'button',
                {
                  class: 'button button-small button-ghost',
                  type: 'button',
                  onclick: () => setPreview(!preview),
                },
                preview ? 'Hide preview' : 'Preview',
              )
            : null,
          h(
            'a',
            {
              class: 'icon-button',
              href: `${url}?download=1`,
              download: name,
              title: 'Download',
              'aria-label': `Download ${name}`,
            },
            icon('download', 16),
          ),
        );

        if (isPdf && preview) {
          // The frame is created only when asked for: PDFs are expensive.
          if (!frame) {
            frame = h('iframe', {
              class: 'attachment-preview',
              src: url,
              title: name,
              loading: 'lazy',
            });
          }
        } else {
          frame = null;
        }
        dom.replaceChildren(row, ...(frame ? [frame] : []));
      }
      render();

      return {
        dom,
        update(updated) {
          if (updated.type !== current.type) return false;
          const changed =
            updated.attrs.preview !== current.attrs.preview ||
            updated.attrs.attachmentId !== current.attrs.attachmentId ||
            updated.attrs.name !== current.attrs.name;
          current = updated;
          if (changed) render();
          return true;
        },
        stopEvent(event) {
          // Buttons and the download link work normally; dragging the block
          // from anywhere else is left to the editor.
          return !!event.target.closest?.('button, a') && event.type !== 'dragstart';
        },
        ignoreMutation() {
          return true;
        },
      };
    };
  },
});
