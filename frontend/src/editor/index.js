// The MindDock block editor: Tiptap/ProseMirror configured with the block
// catalogue, Markdown input rules and the contextual controls. This module is
// loaded lazily, so pages without an editor never pay for it.
import { Editor } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { StarterKit } from '@tiptap/starter-kit';
import { Attachment } from './extensions/attachment.js';
import { BlockHandle } from './extensions/block-handle.js';
import { BlockKeys } from './extensions/block-keys.js';
import { BubbleToolbar } from './extensions/bubble-toolbar.js';
import { Callout } from './extensions/callout.js';
import { CodeBlock } from './extensions/code-block.js';
import { Divider } from './extensions/divider.js';
import { ImageBlock } from './extensions/image.js';
import { LinkEditor } from './extensions/link-editor.js';
import { SlashCommands } from './extensions/slash.js';
import { TableToolbar } from './extensions/table-toolbar.js';
import { Uploads } from './extensions/uploads.js';
import { isSafeUrl } from './urls.js';

function placeholderFor({ node, editor }) {
  if (node.type.name === 'heading') return `Heading ${node.attrs.level}`;
  if (node.type.name === 'codeBlock') return '';
  if (editor.isEmpty) return 'Start writing, or press “/” for blocks';
  return 'Type “/” for blocks';
}

/** Extensions that define the document schema (shared with read-only previews). */
function schemaExtensions() {
  return [
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
    TaskItem.configure({ nested: true }),
    CodeBlock,
    TableKit.configure({ table: { resizable: true, lastColumnResizable: false } }),
    Callout,
    ImageBlock,
    Attachment,
  ];
}

/**
 * @param {object} options
 * @param {HTMLElement} options.element   mount point (position: relative)
 * @param {object} options.content        ProseMirror JSON document
 * @param {boolean} options.editable
 * @param {(file: File) => Promise<object>} [options.upload]
 * @param {object} [options.limits]
 * @param {() => void} [options.onChange] called after every document change
 * @param {() => void} [options.onExitTop] ArrowUp on the first line
 */
export function createEditor({
  element,
  content,
  editable = true,
  upload,
  limits,
  onChange,
  onExitTop,
}) {
  const interactive = editable
    ? [
        Placeholder.configure({ placeholder: placeholderFor, showOnlyCurrent: true }),
        SlashCommands,
        BlockHandle,
        BubbleToolbar,
        TableToolbar,
        BlockKeys.configure({ onExitTop }),
        Uploads.configure({ upload, limits }),
      ]
    : [];

  const editor = new Editor({
    element,
    extensions: [...schemaExtensions(), LinkEditor, ...interactive],
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
 * Move the caret to the start of the document and focus the editor right
 * away. (Tiptap's own focus command waits a frame, which would swallow keys
 * typed immediately after pressing Enter in the title.)
 */
export function focusEditorStart(editor) {
  const { view, state } = editor;
  view.dispatch(state.tr.setSelection(Selection.atStart(state.doc)));
  view.focus();
}
