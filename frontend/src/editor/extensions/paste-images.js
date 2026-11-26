// Pasting rich text that contains pictures (Word, web pages, other editors).
//
// Browsers hand over the text as HTML, but the pictures in it are not usable
// as they are: Word points at temporary files on disk (file:///…), others use
// data: URIs or addresses on another site. Before the HTML is inserted, every
// picture is turned into an uploaded attachment:
//   file://  → the bytes are recovered from the RTF flavour of the clipboard
//   data:    → decoded directly
//   https:// → fetched by the server (when that is enabled)
import { Extension } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import { toast } from '../../lib/toast.js';
import { normalizePastedHtml } from '../notion-html.js';
import { appContext } from './app-context.js';

const PICTURE_HEADER =
  /\{\\pict[\s\S]+?\\bliptag-?\d+(\\blipupi-?\d+)?(\{\\\*\\blipuid\s?[\da-fA-F]+)?[\s}]*?/;
const PICTURE = new RegExp(`(?:(${PICTURE_HEADER.source}))([\\da-fA-F\\s]+)\\}`, 'g');

/** Pictures embedded in RTF, in document order (the approach Word importers use). */
export function extractRtfImages(rtf) {
  const images = [];
  for (const match of rtf?.match(PICTURE) ?? []) {
    let type = null;
    if (match.includes('\\pngblip')) type = 'image/png';
    else if (match.includes('\\jpegblip')) type = 'image/jpeg';
    if (!type) continue;
    const hex = match.replace(PICTURE_HEADER, '').replace(/[^\da-fA-F]/g, '');
    if (hex.length < 16) continue;
    const bytes = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    images.push(new Blob([bytes], { type }));
  }
  return images;
}

function dataUriToBlob(uri) {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([\s\S]+)$/i.exec(uri);
  if (!match) return null;
  try {
    const binary = atob(match[2].replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: match[1].toLowerCase() });
  } catch {
    return null;
  }
}

function extensionFor(type) {
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[type];
}

function classify(src) {
  if (!src) return 'drop';
  if (/^\/api\/files\/[0-9a-f]{32}/.test(src)) return 'keep';
  if (src.startsWith(`${location.origin}/api/files/`)) return 'keep';
  if (/^file:/i.test(src)) return 'file';
  if (/^data:image\//i.test(src)) return 'data';
  if (/^https?:\/\//i.test(src)) return 'remote';
  return 'drop';
}

/**
 * Upload every foreign picture in `html`; returns the HTML with the pictures
 * pointing at the new attachments (pictures that could not be saved are removed).
 */
export async function importPastedImages(html, rtf, { upload, importImage, remoteFetch }) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const images = [...doc.querySelectorAll('img')];
  const fromFiles = images.filter((img) => classify(img.getAttribute('src')) === 'file');
  const rtfImages = fromFiles.length ? extractRtfImages(rtf) : [];
  // Word lists pictures in the same order in both flavours; only trust the
  // pairing when the counts agree.
  const paired = rtfImages.length === fromFiles.length;
  let failed = 0;

  await Promise.all(
    images.map(async (img, index) => {
      const src = img.getAttribute('src');
      const kind = classify(src);
      if (kind === 'keep') return;
      let attachment = null;
      try {
        if (kind === 'file' && paired) {
          const blob = rtfImages[fromFiles.indexOf(img)];
          attachment = await upload(
            new File([blob], `image-${index + 1}.${extensionFor(blob.type)}`, { type: blob.type }),
          );
        } else if (kind === 'data') {
          const blob = dataUriToBlob(src);
          if (blob) {
            attachment = await upload(
              new File([blob], `image-${index + 1}.${extensionFor(blob.type)}`, { type: blob.type }),
            );
          }
        } else if (kind === 'remote' && remoteFetch) {
          attachment = await importImage(src);
        }
      } catch {
        attachment = null;
      }
      if (attachment?.kind === 'image') {
        img.setAttribute('src', `/api/files/${attachment.id}`);
        img.removeAttribute('srcset');
      } else {
        failed += 1;
        img.remove();
      }
    }),
  );
  // Word wraps each picture in a paragraph of its own. An image is a block
  // here, so such a wrapper would be left behind as an empty line.
  for (const img of doc.querySelectorAll('img')) {
    const parent = img.parentElement;
    if (
      parent &&
      /^(P|DIV|SPAN)$/.test(parent.tagName) &&
      parent !== doc.body &&
      !parent.textContent.trim() &&
      parent.querySelectorAll('img').length === 1
    ) {
      parent.replaceWith(img);
    }
  }
  return { html: doc.body.innerHTML, failed };
}

export const PasteImages = Extension.create({
  name: 'pasteImages',
  addOptions() {
    return { upload: async () => null };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const { upload } = this.options;
    return [
      new Plugin({
        key: new PluginKey('pasteImages'),
        props: {
          // Every pasted HTML passes here (also after its pictures were
          // imported below): to-dos, toggles and callouts copied from Notion
          // become the editor's own blocks.
          transformPastedHTML: (html) => normalizePastedHtml(html),
          handlePaste(view, event) {
            if (!editor.isEditable) return false;
            const html = event.clipboardData?.getData('text/html');
            // What the last paste brought, for looking into a paste that went
            // wrong: copy(JSON.stringify(kamispaceLastPaste)) in the console.
            // Kept in memory only, until the next paste or reload.
            try {
              const data = event.clipboardData;
              window.kamispaceLastPaste = Object.fromEntries([...(data?.types ?? [])].filter((type) => type !== 'Files').map((type) => [type, data.getData(type)]));
            } catch {
              // Looking is optional; pasting goes on.
            }
            if (!html || !/<img\b/i.test(html)) return false;
            const probe = new DOMParser().parseFromString(html, 'text/html');
            const foreign = [...probe.querySelectorAll('img')].filter(
              (img) => classify(img.getAttribute('src')) !== 'keep',
            );
            if (!foreign.length) return false;

            event.preventDefault();
            const rtf = event.clipboardData.getData('text/rtf');
            const context = appContext(editor);
            const notice = toast(
              `Importing ${foreign.length} image${foreign.length === 1 ? '' : 's'}…`,
              { duration: 60000 },
            );
            importPastedImages(html, rtf, {
              upload,
              importImage: context.importImage,
              remoteFetch: context.remoteFetch,
            }).then(({ html: ready, failed }) => {
              notice.dismiss();
              if (view.isDestroyed) return;
              view.pasteHTML(ready);
              // Pasted content that ends with a picture leaves that picture
              // selected; carry on writing below it instead.
              const { selection, doc } = view.state;
              if (selection instanceof NodeSelection) {
                const after = Selection.findFrom(doc.resolve(selection.to), 1, true);
                if (after) view.dispatch(view.state.tr.setSelection(after));
              }
              if (failed) {
                toast(
                  `${failed} image${failed === 1 ? '' : 's'} could not be imported and ${failed === 1 ? 'was' : 'were'} left out`,
                  { type: 'error' },
                );
              }
            });
            return true;
          },
        },
      }),
    ];
  },
});
