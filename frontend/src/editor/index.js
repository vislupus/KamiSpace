// The KamiSpace block editor: Tiptap/ProseMirror configured with the block
// catalogue, Markdown input rules and the contextual controls. This module is
// loaded lazily, so pages without an editor never pay for it.
import { Editor } from '@tiptap/core';
import { TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import { Selection } from '@tiptap/pm/state';
import { StarterKit } from '@tiptap/starter-kit';
import { AppContext } from './extensions/app-context.js';
import { Attachment } from './extensions/attachment.js';
import { BlockHandle } from './extensions/block-handle.js';
import { BlockKeys } from './extensions/block-keys.js';
import { Bookmark } from './extensions/bookmark.js';
import { BubbleToolbar } from './extensions/bubble-toolbar.js';
import { Callout } from './extensions/callout.js';
import { CodeBlock } from './extensions/code-block.js';
import { Highlight, TextColor } from './extensions/colors.js';
import { Column, Columns } from './extensions/columns.js';
import { Divider } from './extensions/divider.js';
import { Embed } from './extensions/embed.js';
import { Emoji } from './extensions/emoji.js';
import { BlockEquation, InlineEquation } from './extensions/equation.js';
import { ImageBlock } from './extensions/image.js';
import { LinkEditor } from './extensions/link-editor.js';
import { Audio, Video } from './extensions/media.js';
import { DatabaseBlock } from './extensions/database.js';
import { NotionKeys } from './extensions/notion-keys.js';
import { PageLink, PageMention, PageMentions } from './extensions/page-link.js';
import { PasteImages } from './extensions/paste-images.js';
import { SlashCommands } from './extensions/slash.js';
import { TableControls } from './extensions/table-controls.js';
import { AssignableTaskItem } from './extensions/task-item.js';
import { Toggle, ToggleContent, ToggleSummary } from './extensions/toggle.js';
import { Uploads } from './extensions/uploads.js';
import { documentToMarkdown, markdownFileName, markdownToDocument } from './markdown.js';
import { isSafeUrl } from './urls.js';

export { documentToMarkdown, markdownFileName };

function placeholderFor({ node, editor }) {
  if (node.type.name === 'heading') return `Heading ${node.attrs.level}`;
  if (node.type.name === 'detailsSummary') return 'Toggle';
  if (node.type.name === 'codeBlock') return '';
  if (editor.isEmpty) return 'Start writing, or press “/” for blocks';
  return 'Type “/” for blocks';
}

/** Extensions that define the document schema (shared with read-only previews). */
function schemaExtensions(context, upload = null) {
  return [
    AppContext.configure(context ?? {}),
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      codeBlock: false,
      horizontalRule: false,
      dropcursor: { color: 'var(--accent)', width: 2 },
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
        isAllowedUri: (url) => isSafeUrl(url),
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
      },
    }),
    Divider,
    TaskList,
    AssignableTaskItem,
    CodeBlock,
    TableKit.configure({ table: { resizable: true, lastColumnResizable: false } }),
    Callout,
    Toggle,
    ToggleSummary,
    ToggleContent,
    Columns,
    Column,
    ImageBlock.configure({ upload }),
    Attachment,
    Video,
    Audio,
    Embed,
    Bookmark,
    BlockEquation,
    InlineEquation,
    PageLink,
    DatabaseBlock,
    PageMention,
    TextColor,
    Highlight,
    Markdown,
  ];
}

/**
 * @param {object} options
 * @param {HTMLElement} options.element   mount point (position: relative)
 * @param {object} options.content        ProseMirror JSON document
 * @param {boolean} options.editable
 * @param {object} [options.context]      see extensions/app-context.js
 * @param {(file: File) => Promise<object>} [options.upload]
 * @param {object} [options.limits]
 * @param {() => void} [options.onChange] called after every document change
 * @param {() => void} [options.onExitTop] ArrowUp on the first line
 */
export function createEditor({
  element,
  content,
  editable = true,
  context,
  upload,
  limits,
  onChange,
  onExitTop,
}) {
  const interactive = editable
    ? [
        Placeholder.configure({
          placeholder: placeholderFor,
          showOnlyCurrent: true,
          includeChildren: true,
        }),
        SlashCommands,
        PageMentions,
        Emoji,
        BlockHandle,
        BubbleToolbar,
        TableControls,
        BlockKeys.configure({ onExitTop }),
        NotionKeys,
        PasteImages.configure({ upload }),
        Uploads.configure({ upload, limits }),
      ]
    : [];

  const editor = new Editor({
    element,
    extensions: [...schemaExtensions(context, editable ? upload : null), LinkEditor, ...interactive],
    content,
    editable,
    injectCSS: false,
    editorProps: {
      attributes: {
        class: 'doc',
        spellcheck: 'true',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Page content',
      },
    },
    onUpdate: ({ transaction }) => {
      if (transaction.docChanged) onChange?.();
    },
  });
  return editor;
}

/**
 * Parse a Markdown file into { title, content } without showing an editor.
 * (The parser needs the schema, so a detached editor is created for a moment.)
 */
export function parseMarkdown(markdown, fallbackTitle = '') {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: schemaExtensions(null),
    editable: false,
    injectCSS: false,
  });
  try {
    return markdownToDocument(editor, markdown, fallbackTitle);
  } finally {
    editor.destroy();
  }
}

/**
 * Move the caret to the start of the document and focus the editor right
 * away. (Tiptap's own focus command waits a frame, which would swallow keys
 * typed immediately after pressing Enter in the title.)
 */
export function focusEditorStart(editor) {
  const { view, state } = editor;
  view.dispatch(state.tr.setSelection(Selection.atStart(state.doc)));
  view.focus();
}
