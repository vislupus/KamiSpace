// The block catalogue. Slash commands, the "+" button and the "Turn into"
// menu are all generated from this list — adding a block type means adding an
// entry here (plus its Tiptap extension and the server's allow-list).
import { wrapSelectionIn } from './block-ops.js';
import { promptForBookmark } from './extensions/bookmark.js';
import { promptForEmbed } from './extensions/embed.js';
import { openLinkEditor } from './extensions/link-editor.js';
import { insertSubPage } from './extensions/page-link.js';
import { pickAndUploadFiles } from './extensions/uploads.js';

const CONTAINERS = ['bulletList', 'orderedList', 'taskList', 'blockquote', 'callout', 'details'];

/**
 * id          slash command name (/id)
 * convert     true when an existing block can be turned into this type
 * reset       clear wrapping nodes (lists, quotes) before applying
 * apply       (chain) => chain   — a Tiptap command chain step
 * action      (editor) => void   — for blocks that need UI (file pickers…)
 * isActive    (editor) => boolean
 */
export const BLOCKS = [
  {
    id: 'text',
    title: 'Text',
    description: 'Plain paragraph',
    icon: 'text',
    keywords: ['paragraph', 'plain', 'p'],
    convert: true,
    reset: true,
    apply: (chain) => chain.setParagraph(),
    isActive: (editor) =>
      editor.isActive('paragraph') && !CONTAINERS.some((name) => editor.isActive(name)),
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
    convert: true,
    reset: true,
    apply: (chain) => chain.setHeading({ level }),
    isActive: (editor) => editor.isActive('heading', { level }),
  })),
  {
    id: 'bullet',
    title: 'Bulleted list',
    description: 'Simple list',
    icon: 'list',
    hint: '-',
    keywords: ['bulleted', 'unordered', 'list', 'ul'],
    convert: true,
    apply: (chain) => chain.toggleBulletList(),
    isActive: (editor) => editor.isActive('bulletList'),
  },
  {
    id: 'numbered',
    title: 'Numbered list',
    description: 'Ordered list',
    icon: 'list-ordered',
    hint: '1.',
    keywords: ['ordered', 'number', 'list', 'ol'],
    convert: true,
    apply: (chain) => chain.toggleOrderedList(),
    isActive: (editor) => editor.isActive('orderedList'),
  },
  {
    id: 'todo',
    title: 'To-do list',
    description: 'Tasks you can tick, assign and date',
    icon: 'list-todo',
    hint: '[]',
    keywords: ['todo', 'task', 'checklist', 'checkbox', 'check', 'assign'],
    convert: true,
    apply: (chain) => chain.toggleTaskList(),
    isActive: (editor) => editor.isActive('taskList'),
  },
  {
    id: 'toggle',
    title: 'Toggle list',
    description: 'Hide and show content',
    icon: 'toggle',
    hint: '>>',
    keywords: ['toggle', 'collapse', 'expand', 'details', 'fold', 'accordion'],
    convert: true,
    toggle: true,
    apply: (chain) => chain.setToggle(0),
    isActive: (editor) => editor.isActive('details', { level: 0 }),
  },
  ...[1, 2, 3].map((level) => ({
    id: `toggleh${level}`,
    title: `Toggle heading ${level}`,
    description: 'A heading that hides its content',
    icon: `h${level}`,
    keywords: ['toggle', 'collapse', 'heading', `toggle${level}`, 'fold'],
    convert: true,
    toggle: true,
    apply: (chain) => chain.setToggle(level),
    isActive: (editor) => editor.isActive('details', { level }),
  })),
  {
    id: 'quote',
    title: 'Quote',
    description: 'Blockquote',
    icon: 'quote',
    hint: '>',
    keywords: ['blockquote', 'citation'],
    convert: true,
    apply: (chain) => chain.command(wrapSelectionIn('blockquote')),
    isActive: (editor) => editor.isActive('blockquote'),
  },
  {
    id: 'code',
    title: 'Code block',
    description: 'With syntax highlighting',
    icon: 'code-block',
    hint: '```',
    keywords: ['codeblock', 'snippet', 'pre', 'programming'],
    convert: true,
    reset: true,
    apply: (chain) => chain.setCodeBlock(),
    isActive: (editor) => editor.isActive('codeBlock'),
  },
  {
    id: 'callout',
    title: 'Callout',
    description: 'Highlighted note',
    icon: 'info',
    keywords: ['note', 'info', 'warning', 'tip', 'admonition', 'highlight'],
    convert: true,
    apply: (chain) => chain.command(wrapSelectionIn('callout')),
    isActive: (editor) => editor.isActive('callout'),
  },
  {
    id: 'divider',
    title: 'Divider',
    description: 'Horizontal line',
    icon: 'minus',
    hint: '---',
    keywords: ['hr', 'rule', 'line', 'separator'],
    apply: (chain) => chain.setHorizontalRule(),
  },
  {
    id: 'table',
    title: 'Table',
    description: '3 × 3 table with a header row',
    icon: 'table',
    keywords: ['grid', 'rows'],
    apply: (chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
  },
  ...[2, 3, 4].map((count) => ({
    id: `columns${count}`,
    title: `${count} columns`,
    description: 'Blocks side by side',
    icon: 'columns-2',
    keywords: ['columns', 'column', 'layout', 'side', `${count}columns`, 'col'],
    apply: (chain) => chain.insertColumns(count),
  })),
  {
    id: 'page',
    title: 'Page',
    description: 'New sub-page, linked here',
    icon: 'file-text',
    keywords: ['subpage', 'sub-page', 'child', 'new', 'nested'],
    action: (editor) => insertSubPage(editor),
  },
  {
    id: 'linkpage',
    title: 'Link to page',
    description: 'Mention another page (or type @)',
    icon: 'at',
    hint: '@',
    keywords: ['mention', 'reference', 'backlink', 'pagelink', 'link'],
    action: (editor) => editor.chain().focus().insertContent('@').run(),
  },
  {
    id: 'image',
    title: 'Image',
    description: 'Upload a picture',
    icon: 'image',
    keywords: ['picture', 'photo', 'screenshot', 'img'],
    action: (editor) => pickAndUploadFiles(editor, { kind: 'image' }),
  },
  {
    id: 'video',
    title: 'Video',
    description: 'Upload a video file',
    icon: 'video',
    keywords: ['movie', 'mp4', 'film', 'clip'],
    action: (editor) => pickAndUploadFiles(editor, { kind: 'video' }),
  },
  {
    id: 'audio',
    title: 'Audio',
    description: 'Upload a sound file',
    icon: 'audio',
    keywords: ['sound', 'music', 'mp3', 'recording', 'podcast'],
    action: (editor) => pickAndUploadFiles(editor, { kind: 'audio' }),
  },
  {
    id: 'file',
    title: 'File',
    description: 'Attach a PDF or document',
    icon: 'paperclip',
    keywords: ['attachment', 'upload', 'pdf', 'document'],
    action: (editor) => pickAndUploadFiles(editor, { kind: 'any' }),
  },
  {
    id: 'embed',
    title: 'Embed',
    description: 'Web page, YouTube or Vimeo',
    icon: 'embed',
    keywords: ['iframe', 'website', 'youtube', 'vimeo', 'web', 'frame'],
    action: (editor) => promptForEmbed(editor),
  },
  {
    id: 'bookmark',
    title: 'Web bookmark',
    description: 'Link card with title and description',
    icon: 'bookmark',
    keywords: ['bookmark', 'link', 'preview', 'card', 'url', 'website'],
    action: (editor) => promptForBookmark(editor),
  },
  {
    id: 'equation',
    title: 'Block equation',
    description: 'Display math (KaTeX)',
    icon: 'equation',
    keywords: ['math', 'latex', 'tex', 'formula', 'katex', 'equation'],
    apply: (chain) => chain.insertBlockEquation(),
  },
  {
    id: 'inlineequation',
    title: 'Inline equation',
    description: 'Math inside a sentence',
    icon: 'equation',
    hint: '$$…$$',
    keywords: ['math', 'latex', 'tex', 'formula', 'katex', 'inline'],
    apply: (chain) => chain.setInlineEquation(),
  },
  {
    id: 'link',
    title: 'Link',
    description: 'Insert a web link',
    icon: 'link',
    keywords: ['url', 'href', 'web'],
    action: (editor) => openLinkEditor(editor),
  },
];

export const CONVERTIBLE_BLOCKS = BLOCKS.filter((block) => block.convert);

/** Apply a block type at the current selection. */
export function applyBlock(editor, block) {
  if (block.action) {
    block.action(editor);
    return;
  }
  if (block.isActive?.(editor)) {
    editor.commands.focus();
    return;
  }
  let chain = editor.chain().focus();
  // Leaving a toggle for another block type: its summary becomes plain text first.
  if (block.convert && !block.toggle && editor.isActive('detailsSummary')) {
    chain = chain.unsetDetails();
  }
  if (block.reset || (block.toggle && !editor.isActive('details'))) chain = chain.clearNodes();
  block.apply(chain).run();
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
  return CONVERTIBLE_BLOCKS.find((block) => block.isActive(editor))?.title ?? 'Text';
}
