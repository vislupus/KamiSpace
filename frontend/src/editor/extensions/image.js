import { Node, mergeAttributes } from '@tiptap/core';
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { openMenu } from '../../lib/menu.js';
import { clamp } from '../../lib/util.js';
import { deleteBlock } from '../block-ops.js';

const FILE_URL = /\/api\/files\/([0-9a-f]{32})/;
const ALIGNMENTS = ['left', 'center', 'right'];
const MIN_WIDTH = 10; // percent of the text column

export function fileUrl(attachmentId) {
  return `/api/files/${attachmentId}`;
}

/** Full-size view of a picture; click anywhere or press Escape to close. */
export function openLightbox(src, alt = '') {
  const overlay = h(
    'div',
    { class: 'lightbox', role: 'dialog', 'aria-label': 'Image', tabIndex: -1 },
    h('img', { src, alt }),
  );
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  overlay.focus();
}

/**
 * Image block. Only images uploaded to KamiSpace can be embedded: the node
 * stores an attachment id, never an arbitrary URL, so pages cannot load
 * remote trackers and access control always applies.
 *
 * Like in Notion the picture is centred, can be resized with the handles on
 * its sides, and shows a small toolbar on hover (caption, alignment, full
 * size, download, more).
 */
export const ImageBlock = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return {
      /** (file: File) => Promise<{ id, kind }> — used by "Replace" */
      upload: null,
    };
  },

  addAttributes() {
    return {
      attachmentId: { default: null },
      alt: { default: null },
      width: { default: null },
      align: { default: 'center' },
      caption: { default: null },
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
          align: ALIGNMENTS.includes(element.getAttribute('data-align'))
            ? element.getAttribute('data-align')
            : 'center',
          caption: element.querySelector('figcaption')?.textContent || null,
        }),
      },
      {
        // Images copied from another KamiSpace page, or uploaded while pasting.
        tag: 'img[src]',
        getAttrs: (element) => {
          const match = (element.getAttribute('src') || '').match(FILE_URL);
          return match ? { attachmentId: match[1], alt: element.getAttribute('alt') } : false;
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const { attachmentId, alt, width, align, caption } = node.attrs;
    return [
      'figure',
      mergeAttributes(HTMLAttributes, {
        class: 'image-block',
        'data-attachment-id': attachmentId,
        'data-width': width || null,
        'data-align': align || 'center',
      }),
      ['img', { src: fileUrl(attachmentId), alt: alt || '' }],
      ...(caption ? [['figcaption', {}, caption]] : []),
    ];
  },

  // Markdown: ![alt](/api/files/<id>). Pictures are lifted out of paragraphs
  // (and foreign addresses turned into links) in editor/markdown.js.
  markdownTokenName: 'image',
  parseMarkdown: (token) => ({ type: 'image', attrs: { src: token.href, alt: token.text } }),
  renderMarkdown: (node) =>
    `![${(node.attrs?.alt ?? '').replace(/[\[\]]/g, '')}](${fileUrl(node.attrs?.attachmentId)})`,

  addNodeView() {
    const { upload } = this.options;
    return ({ node, getPos, editor }) => {
      let current = node;
      let captionOpen = false;
      const editable = editor.isEditable;

      const image = h('img', {
        alt: current.attrs.alt || '',
        loading: 'lazy',
        decoding: 'async',
        draggable: false,
      });
      const frame = h('div', { class: 'image-frame' }, image);
      const captionSlot = h('figcaption', { class: 'image-caption' });
      const dom = h('figure', { class: 'image-block', contentEditable: 'false' }, frame, captionSlot);

      const setAttributes = (changes) => {
        if (!editable || typeof getPos !== 'function') return;
        const pos = getPos();
        const live = editor.state.doc.nodeAt(pos);
        if (!live || live.type !== current.type) return;
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(pos, undefined, { ...live.attrs, ...changes }),
        );
      };

      // -- caption ----------------------------------------------------------
      const renderCaption = () => {
        const text = current.attrs.caption || '';
        if (!editable) {
          captionSlot.replaceChildren(text);
          captionSlot.hidden = !text;
          return;
        }
        captionSlot.hidden = !text && !captionOpen;
        if (captionSlot.hidden) {
          captionSlot.replaceChildren();
          return;
        }
        let input = captionSlot.querySelector('input');
        if (!input) {
          input = h('input', {
            class: 'image-caption-input',
            type: 'text',
            placeholder: 'Write a caption…',
            maxLength: 500,
            'aria-label': 'Caption',
          });
          const commit = () => {
            captionOpen = false;
            const value = input.value.trim() || null;
            if (value !== (current.attrs.caption || null)) setAttributes({ caption: value });
            else renderCaption();
          };
          input.addEventListener('blur', commit);
          input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === 'Escape') {
              event.preventDefault();
              if (event.key === 'Escape') input.value = current.attrs.caption || '';
              input.blur();
              editor.view.focus();
            }
          });
          captionSlot.replaceChildren(input);
        }
        if (document.activeElement !== input) input.value = text;
      };

      // -- toolbar ------------------------------------------------------------
      const tool = (label, iconName, onClick) => {
        const button = h(
          'button',
          { class: 'image-tool', type: 'button', title: label, 'aria-label': label },
          icon(iconName, 15),
        );
        button.addEventListener('mousedown', (event) => event.preventDefault());
        button.addEventListener('click', (event) => onClick(event, button));
        return button;
      };
      const tools = h('div', { class: 'image-tools' });
      if (editable) {
        tools.append(
          tool('Caption', 'caption', () => {
            captionOpen = true;
            renderCaption();
            captionSlot.querySelector('input')?.focus();
          }),
          tool('Align', 'align', (_event, button) => {
            openMenu({
              anchor: button,
              placement: 'bottom-end',
              items: ALIGNMENTS.map((value) => ({
                label: value[0].toUpperCase() + value.slice(1),
                checked: (current.attrs.align || 'center') === value,
                onSelect: () => setAttributes({ align: value }),
              })),
            });
          }),
        );
      }
      tools.append(
        tool('View original', 'maximize', () =>
          openLightbox(fileUrl(current.attrs.attachmentId), current.attrs.alt || ''),
        ),
        h(
          'a',
          {
            class: 'image-tool',
            href: `${fileUrl(current.attrs.attachmentId)}?download=1`,
            download: current.attrs.alt || 'image',
            title: 'Download',
            'aria-label': 'Download',
          },
          icon('download', 15),
        ),
      );
      if (editable) {
        tools.append(
          tool('More', 'more', (_event, button) => {
            openMenu({
              anchor: button,
              placement: 'bottom-end',
              items: [
                upload
                  ? {
                      label: 'Replace…',
                      icon: 'image',
                      onSelect: () => {
                        const input = h('input', { type: 'file', accept: '.png,.jpg,.jpeg,.webp,.gif' });
                        input.addEventListener('change', async () => {
                          const file = input.files?.[0];
                          if (!file) return;
                          try {
                            const attachment = await upload(file);
                            if (attachment?.kind === 'image') {
                              setAttributes({ attachmentId: attachment.id, alt: attachment.name });
                            }
                          } catch {
                            // The upload helper reports its own errors.
                          }
                        });
                        input.click();
                      },
                    }
                  : null,
                {
                  label: 'Original size',
                  icon: 'restore',
                  disabled: !current.attrs.width,
                  onSelect: () => setAttributes({ width: null }),
                },
                { separator: true },
                {
                  label: 'Delete',
                  icon: 'trash-2',
                  danger: true,
                  onSelect: () => deleteBlock(editor, getPos()),
                },
              ],
            });
          }),
        );
      }
      frame.append(tools);

      // -- resizing -----------------------------------------------------------
      const addHandle = (side) => {
        const handle = h('div', {
          class: `image-handle image-handle-${side}`,
          title: 'Drag to resize',
          'aria-hidden': 'true',
        });
        handle.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const available = dom.clientWidth || 1;
          const startWidth = frame.getBoundingClientRect().width;
          const startX = event.clientX;
          // A centred picture grows on both sides at once.
          const factor = (current.attrs.align || 'center') === 'center' ? 2 : 1;
          const direction = side === 'right' ? 1 : -1;
          let percent = current.attrs.width;
          handle.setPointerCapture(event.pointerId);
          dom.classList.add('is-resizing');
          const onMove = (move) => {
            const width = startWidth + (move.clientX - startX) * direction * factor;
            percent = Math.round(clamp((width / available) * 100, MIN_WIDTH, 100));
            frame.style.width = `${percent}%`;
          };
          const onUp = () => {
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            handle.removeEventListener('pointercancel', onUp);
            dom.classList.remove('is-resizing');
            if (percent && percent !== current.attrs.width) setAttributes({ width: percent });
          };
          handle.addEventListener('pointermove', onMove);
          handle.addEventListener('pointerup', onUp);
          handle.addEventListener('pointercancel', onUp);
        });
        frame.append(handle);
      };
      if (editable) {
        addHandle('left');
        addHandle('right');
      }
      image.addEventListener('dblclick', () =>
        openLightbox(fileUrl(current.attrs.attachmentId), current.attrs.alt || ''),
      );

      const render = () => {
        const { attachmentId, alt, width, align } = current.attrs;
        const src = fileUrl(attachmentId);
        if (image.getAttribute('src') !== src) image.src = src;
        image.alt = alt || '';
        dom.dataset.align = align || 'center';
        frame.style.width = width ? `${width}%` : '';
        renderCaption();
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
        // Toolbar, handles and the caption field are ours; the rest of the
        // picture behaves like any block (click selects it, it can be dragged).
        stopEvent: (event) =>
          !!event.target.closest?.('.image-tools, .image-handle, .image-caption') &&
          event.type !== 'dragstart',
        ignoreMutation: () => true,
      };
    };
  },

  addCommands() {
    return {
      setImageWidth:
        (width) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, { width }),
    };
  },
});
