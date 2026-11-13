// Uploading files into the document: drag & drop, paste, and file pickers.
// While a file uploads, a placeholder decoration marks where it will land.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { toast } from '../../lib/toast.js';
import { fileExtension, formatBytes } from '../../lib/util.js';

const key = new PluginKey('uploads');
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
let counter = 0;

function placeholderElement(name) {
  const el = document.createElement('div');
  el.className = 'upload-placeholder';
  const spinner = document.createElement('span');
  spinner.className = 'upload-spinner';
  const label = document.createElement('span');
  label.textContent = `Uploading ${name}…`;
  el.append(spinner, label);
  return el;
}

function findPlaceholder(state, id) {
  const found = key.getState(state).find(undefined, undefined, (spec) => spec.id === id);
  return found.length ? found[0].from : null;
}

function options(editor) {
  return editor.extensionManager.extensions.find((ext) => ext.name === 'uploads').options;
}

function validate(file, limits) {
  const extension = fileExtension(file.name);
  if (limits.upload_extensions?.length && !limits.upload_extensions.includes(extension)) {
    return `“${file.name}”: this file type is not supported`;
  }
  if (limits.max_upload_bytes && file.size > limits.max_upload_bytes) {
    return `“${file.name}” is larger than ${formatBytes(limits.max_upload_bytes)}`;
  }
  return null;
}

function nodeFor(schema, attachment) {
  if (attachment.kind === 'image') {
    return schema.nodes.image.create({ attachmentId: attachment.id, alt: attachment.name });
  }
  return schema.nodes.attachment.create({
    attachmentId: attachment.id,
    name: attachment.name,
    size: attachment.size,
    mime: attachment.mime,
    preview: false,
  });
}

/** Upload files and insert them as blocks at `pos` (default: after the current block). */
export function uploadFiles(editor, files, pos = null) {
  const { upload, limits } = options(editor);
  const { view } = editor;
  let insertAt = pos;
  if (insertAt === null) {
    const { $to } = view.state.selection;
    const parent = $to.depth ? $to.node(1) : null;
    const emptyParagraph = parent?.type.name === 'paragraph' && parent.content.size === 0;
    // Reuse an empty paragraph, otherwise insert below the current block.
    insertAt = $to.depth === 0 ? $to.pos : emptyParagraph ? $to.before(1) : $to.after(1);
  }

  for (const file of files) {
    const problem = validate(file, limits);
    if (problem) {
      toast(problem, { type: 'error' });
      continue;
    }
    const id = `upload-${(counter += 1)}`;
    view.dispatch(
      view.state.tr.setMeta(key, { add: { id, pos: insertAt, name: file.name } }),
    );
    upload(file).then(
      (attachment) => {
        if (view.isDestroyed) return;
        const at = findPlaceholder(view.state, id);
        if (at === null) return; // the surrounding content was deleted meanwhile
        const tr = view.state.tr.setMeta(key, { remove: { id } });
        const $at = tr.doc.resolve(at);
        const here = $at.nodeAfter;
        const node = nodeFor(view.state.schema, attachment);
        if (here?.type.name === 'paragraph' && here.content.size === 0 && $at.depth === 0) {
          tr.replaceWith(at, at + here.nodeSize, node);
        } else {
          tr.insert(at, node);
        }
        view.dispatch(tr);
      },
      (error) => {
        if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, { remove: { id } }));
        toast(error?.message || `Could not upload “${file.name}”`, { type: 'error' });
      },
    );
  }
}

/** Open the system file picker, then upload the chosen files. */
export function pickAndUploadFiles(editor, { imagesOnly }) {
  const { limits } = options(editor);
  const extensions = imagesOnly
    ? IMAGE_EXTENSIONS
    : (limits.upload_extensions ?? []).filter(Boolean);
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = extensions.map((extension) => `.${extension}`).join(',');
  input.addEventListener('change', () => {
    if (input.files?.length) uploadFiles(editor, [...input.files]);
    editor.commands.focus();
  });
  input.click();
}

export const Uploads = Extension.create({
  name: 'uploads',

  addOptions() {
    return {
      /** (file: File) => Promise<{ id, name, mime, kind, size }> */
      upload: async () => {
        throw new Error('Uploads are not configured');
      },
      limits: { max_upload_bytes: 0, upload_extensions: [] },
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            let next = set.map(tr.mapping, tr.doc);
            const action = tr.getMeta(key);
            if (action?.add) {
              const pos = Math.min(action.add.pos, tr.doc.content.size);
              const widget = Decoration.widget(pos, () => placeholderElement(action.add.name), {
                id: action.add.id,
                side: -1,
              });
              next = next.add(tr.doc, [widget]);
            } else if (action?.remove) {
              next = next.remove(
                next.find(undefined, undefined, (spec) => spec.id === action.remove.id),
              );
            }
            return next;
          },
        },
        props: {
          decorations(state) {
            return key.getState(state);
          },
          handlePaste(view, event) {
            if (!editor.isEditable) return false;
            const files = [...(event.clipboardData?.files ?? [])];
            // A pasted screenshot has files and no HTML; rich text copied from
            // other apps often carries both, and then the HTML wins.
            if (!files.length || event.clipboardData.getData('text/html')) return false;
            event.preventDefault();
            uploadFiles(editor, files);
            return true;
          },
          handleDrop(view, event, _slice, moved) {
            if (!editor.isEditable || moved) return false;
            const files = [...(event.dataTransfer?.files ?? [])];
            if (!files.length) return false;
            event.preventDefault();
            const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
            let pos = null;
            if (coords) {
              const $pos = view.state.doc.resolve(coords.pos);
              pos = $pos.depth === 0 ? $pos.pos : $pos.after(1);
            }
            uploadFiles(editor, files, pos);
            return true;
          },
        },
      }),
    ];
  },
});
