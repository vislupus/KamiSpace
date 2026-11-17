// The block catalogue. Slash commands, the "+" button and the "Turn into"
// menu are all generated from this list — adding a block type means adding an
// entry here (plus its Tiptap extension and the server's allow-list).
import { blockKind, convertBlock, currentBlockPos, sameKind } from './block-ops.js';
import { promptForBookmark } from './extensions/bookmark.js';
import { promptForEmbed } from './extensions/embed.js';
import { openLinkEditor } from './extensions/link-editor.js';
import { insertSubPage } from './extensions/page-link.js';
import { pickAndUploadFiles } from './extensions/uploads.js';

/**
 * id          slash command name (/id)
 * group       heading the block is listed under in the slash menu
 * kind        for blocks an existing block can be turned into: what it becomes
 *             (see convertBlock in block-ops.js)
 * apply       (chain) => chain   — a Tiptap command chain step; for `kind`
 *             blocks it is only the fallback where blocks cannot be converted
 *             (inside table cells)
 * action      (editor) => void   — for blocks that need UI (file pickers…)
 */
export const BLOCKS = [
  {
    id: 'text',
    title: 'Text',
    description: 'Plain paragraph',
    icon: 'text',
    keywords: ['paragraph', 'plain', 'p'],
    group: 'Basic blocks',
    kind: { kind: 'text' },
    apply: (chain) => chain.setParagraph(),
  },
  ...[1, 2, 3].map((level) => ({
    id: `h${level}`,
    title: `Heading ${level}`,
    description: ['Large section heading', 'Medium section heading', 'Small section heading'][
      level - 1
    ],
    icon: `h${level}`,
    hint: '#'.repeat(level),
    keywords: ['heading', 'title', `heading${level}`, '#'.repeat(level)],
    group: 'Basic blocks',
    kind: { kind: 'heading', level },
    apply: (chain) => chain.setHeading({ level }),
  })),
  {
    id: 'bullet',
    title: 'Bulleted list',
    description: 'Simple list',
    icon: 'list',
    hint: '-',
    keywords: ['bulleted', 'unordered', 'list', 'ul'],
    group: 'Basic blocks',
    kind: { kind: 'bullet' },
    apply: (chain) => chain.toggleBulletList(),
  },
  {
    id: 'numbered',
    title: 'Numbered list',
    description: 'Ordered list',
    icon: 'list-ordered',
    hint: '1.',
    keywords: ['ordered', 'number', 'list', 'ol'],
    group: 'Basic blocks',
    kind: { kind: 'numbered' },
    apply: (chain) => chain.toggleOrderedList(),
  },
  {
    id: 'todo',
    title: 'To-do list',
    description: 'Tasks you can tick, assign and date',
    icon: 'list-todo',
    hint: '[]',
    keywords: ['todo', 'task', 'checklist', 'checkbox', 'check', 'assign'],
    group: 'Basic blocks',
    kind: { kind: 'todo' },
    apply: (chain) => chain.toggleTaskList(),
  },
  {
    id: 'toggle',
    title: 'Toggle list',
    description: 'Hide and show content',
    icon: 'toggle',
    hint: '>>',
    keywords: ['toggle', 'collapse', 'expand', 'details', 'fold', 'accordion'],
    group: 'Basic blocks',
    kind: { kind: 'toggle', level: 0 },
  },
  ...[1, 2, 3].map((level) => ({
    id: `toggleh${level}`,
    title: `Toggle heading ${level}`,
    description: 'A heading that hides its content',
    icon: `h${level}`,
    keywords: ['toggle', 'collapse', 'heading', `toggle${level}`, 'fold'],
    group: 'Basic blocks',
    kind: { kind: 'toggle', level },
  })),
  {
    id: 'quote',
    title: 'Quote',
    description: 'Blockquote',
    icon: 'quote',
    hint: '>',
    keywords: ['blockquote', 'citation'],
    group: 'Basic blocks',
    kind: { kind: 'quote' },
    apply: (chain) => chain.wrapIn('blockquote'),
  },
  {
    id: 'code',
    title: 'Code block',
    description: 'With syntax highlighting',
    icon: 'code-block',
    hint: '```',
    keywords: ['codeblock', 'snippet', 'pre', 'programming'],
    group: 'Basic blocks',
    kind: { kind: 'code' },
    apply: (chain) => chain.setCodeBlock(),
  },
  {
    id: 'callout',
    title: 'Callout',
    description: 'Highlighted note',
    icon: 'info',
    keywords: ['note', 'info', 'warning', 'tip', 'admonition', 'highlight'],
    group: 'Basic blocks',
    kind: { kind: 'callout' },
    apply: (chain) => chain.wrapIn('callout'),
  },
  {
    id: 'divider',
    group: 'Basic blocks',
    title: 'Divider',
    description: 'Horizontal line',
    icon: 'minus',
    hint: '---',
    keywords: ['hr', 'rule', 'line', 'separator'],
    apply: (chain) => chain.setHorizontalRule(),
  },
  {
    id: 'table',
    group: 'Basic blocks',
    title: 'Table',
    description: '3 × 3 table with a header row',
    icon: 'table',
    keywords: ['grid', 'rows'],
    apply: (chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
  },
  ...[2, 3, 4].map((count) => ({
    id: `columns${count}`,
    group: 'Layout',
    title: `${count} columns`,
    description: 'Blocks side by side',
    icon: 'columns-2',
    keywords: ['columns', 'column', 'layout', 'side', `${count}columns`, 'col'],
    apply: (chain) => chain.insertColumns(count),
  })),
  {
    id: 'page',
    group: 'Pages',
    title: 'Page',
    description: 'New sub-page, linked here',
    icon: 'file-text',
    keywords: ['subpage', 'sub-page', 'child', 'new', 'nested'],
    action: (editor) => insertSubPage(editor),
  },
  {
    id: 'linkpage',
    group: 'Pages',
    title: 'Link to page',
    description: 'Mention another page (or type @)',
    icon: 'at',
    hint: '@',
    keywords: ['mention', 'reference', 'backlink', 'pagelink', 'link'],
    action: (editor) => editor.chain().focus().insertContent('@').run(),
  },
  {
    id: 'image',
    group: 'Media',
    title: 'Image',
    description: 'Upload a picture',
    icon: 'image',
    keywords: ['picture', 'photo', 'screenshot', 'img'],
    action: (editor) => pickAndUploadFiles(editor, { kind: 'image' }),
  },
  {
    id: 'video',
    group: 'Media',
    title: 'Video',
    description: 'Upload a video file',
    icon: 'video',
    keywords: ['movie', 'mp4', 'film', 'clip'],
    action: (editor) => pickAndUploadFiles(editor, { kind: 'video' }),
  },
  {
    id: 'audio',
    group: 'Media',
    title: 'Audio',
    description: 'Upload a sound file',
    icon: 'audio',
    keywords: ['sound', 'music', 'mp3', 'recording', 'podcast'],
    action: (editor) => pickAndUploadFiles(editor, { kind: 'audio' }),
  },
  {
    id: 'file',
    group: 'Media',
    title: 'File',
    description: 'Attach a PDF or document',
    icon: 'paperclip',
    keywords: ['attachment', 'upload', 'pdf', 'document'],
    action: (editor) => pickAndUploadFiles(editor, { kind: 'any' }),
  },
  {
    id: 'embed',
    group: 'Media',
    title: 'Embed',
    description: 'Web page, YouTube or Vimeo',
    icon: 'embed',
    keywords: ['iframe', 'website', 'youtube', 'vimeo', 'web', 'frame'],
    action: (editor) => promptForEmbed(editor),
  },
  {
    id: 'bookmark',
    group: 'Media',
    title: 'Web bookmark',
    description: 'Link card with title and description',
    icon: 'bookmark',
    keywords: ['bookmark', 'link', 'preview', 'card', 'url', 'website'],
    action: (editor) => promptForBookmark(editor),
  },
  {
    id: 'equation',
    group: 'Advanced',
    title: 'Block equation',
    description: 'Display math (KaTeX)',
    icon: 'equation',
    keywords: ['math', 'latex', 'tex', 'formula', 'katex', 'equation'],
    apply: (chain) => chain.insertBlockEquation(),
  },
  {
    id: 'inlineequation',
    group: 'Advanced',
    title: 'Inline equation',
    description: 'Math inside a sentence',
    icon: 'equation',
    hint: '$$…$$',
    keywords: ['math', 'latex', 'tex', 'formula', 'katex', 'inline'],
    apply: (chain) => chain.setInlineEquation(),
  },
  {
    id: 'link',
    group: 'Advanced',
    title: 'Link',
    description: 'Insert a web link',
    icon: 'link',
    keywords: ['url', 'href', 'web'],
    action: (editor) => openLinkEditor(editor),
  },
];

export const CONVERTIBLE_BLOCKS = BLOCKS.filter((block) => block.kind);

/** The kind of the block the selection is in (see blockKind), or null. */
function currentKind(editor) {
  const { doc } = editor.state;
  const pos = currentBlockPos(editor.state);
  const node = doc.nodeAt(pos);
  return node ? blockKind(node, doc.resolve(pos).parent) : null;
}

export function isBlockActive(editor, block) {
  return !!block.kind && sameKind(currentKind(editor), block.kind);
}

/** Apply a block type at the current selection. */
export function applyBlock(editor, block) {
  if (block.action) {
    block.action(editor);
    return;
  }
  if (block.kind) {
    // Convert the block the caret is in — wherever it is nested.
    if (convertBlock(editor, currentBlockPos(editor.state), block.kind)) return;
    if (!block.apply) return;
  }
  block.apply(editor.chain().focus()).run();
}

/** Turn the block at a known position into another kind (block menu). */
export function applyBlockAt(editor, pos, block) {
  return convertBlock(editor, pos, block.kind);
}

export function filterBlocks(query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return BLOCKS;
  const scored = [];
  for (const block of BLOCKS) {
    const title = block.title.toLowerCase();
    let score = 0;
    if (block.id === needle) score = 100;
    else if (block.id.startsWith(needle)) score = 80;
    else if (title.startsWith(needle)) score = 70;
    else if (block.keywords.some((keyword) => keyword.startsWith(needle))) score = 50;
    else if (title.includes(needle)) score = 30;
    else if (block.keywords.some((keyword) => keyword.includes(needle))) score = 10;
    if (score) scored.push({ block, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((entry) => entry.block);
}

export function currentBlockLabel(editor) {
  return CONVERTIBLE_BLOCKS.find((block) => isBlockActive(editor, block))?.title ?? 'Text';
}
