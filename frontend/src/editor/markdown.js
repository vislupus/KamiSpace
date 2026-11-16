// Markdown export and import, built on Tiptap's Markdown support. Standard
// blocks become ordinary Markdown; KamiSpace-specific blocks (callouts,
// columns, embeds, attachments…) use ":::name {attributes}" blocks so that a
// page exported here can be imported again without losing structure.

const FILE_URL = /\/api\/files\/([0-9a-f]{32})/;

/** Markdown for the whole document, with the page title as its first heading. */
export function documentToMarkdown(editor, title) {
  const body = editor.getMarkdown().trim();
  const heading = title ? `# ${title}\n\n` : '';
  return `${heading}${body}\n`;
}

/** What a Markdown picture becomes: an image block for an attachment, else a link. */
function convertImage(node) {
  const src = node.attrs?.src ?? '';
  const alt = node.attrs?.alt || null;
  const match = FILE_URL.exec(src);
  if (match) return { block: { type: 'image', attrs: { attachmentId: match[1], alt, width: null } } };
  if (/^https?:\/\//i.test(src)) {
    return { inline: { type: 'text', text: alt || src, marks: [{ type: 'link', attrs: { href: src } }] } };
  }
  return {};
}

/**
 * Pictures in Markdown carry an address; here an image is a block that points
 * at an uploaded attachment. Images of this instance (/api/files/<id>) are
 * kept, pictures on other sites become plain links (nothing is embedded from
 * elsewhere), wherever the parser put them.
 */
function normalizeImages(node) {
  if (node.type === 'image') {
    const { block, inline } = convertImage(node);
    if (block) return [block];
    return inline ? [{ type: 'paragraph', content: [inline] }] : [];
  }
  if (!Array.isArray(node.content)) return [node];
  if (node.type !== 'paragraph') {
    return [{ ...node, content: node.content.flatMap(normalizeImages) }];
  }
  // A paragraph: split it around any image blocks it contains.
  const result = [];
  let inline = [];
  const flush = () => {
    if (inline.some((child) => child.type !== 'text' || child.text.trim())) {
      result.push({ ...node, content: inline });
    }
    inline = [];
  };
  for (const child of node.content) {
    if (child.type !== 'image') {
      inline.push(child);
      continue;
    }
    const converted = convertImage(child);
    if (converted.block) {
      flush();
      result.push(converted.block);
    } else if (converted.inline) {
      inline.push(converted.inline);
    }
  }
  flush();
  return result.length ? result : [{ type: 'paragraph' }];
}

/**
 * Parse a Markdown file. A leading "# Heading" becomes the page title.
 * Returns { title, content } where content is an editor document.
 */
export function markdownToDocument(editor, markdown, fallbackTitle = '') {
  let source = markdown.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  let title = fallbackTitle;
  const heading = /^\s*#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\n|$)/.exec(source);
  if (heading) {
    title = heading[1].trim();
    source = source.slice(heading[0].length);
  }
  const parsed = editor.markdown.parse(source);
  const blocks = (parsed.content ?? []).flatMap(normalizeImages);
  return {
    title,
    content: { type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] },
  };
}

/** A safe file name for a page title. */
export function markdownFileName(title) {
  const base = (title || 'Untitled')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${base || 'Untitled'}.md`;
}
