// Importing a Markdown file as a new page.
import { toast, toastError } from '../lib/toast.js';
import { createPage } from './actions.js';

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/**
 * Ask for a .md file and create a page from it. The page goes inside
 * `parentId` when given, otherwise to the top of `workspaceId`.
 */
export async function importMarkdown({ workspaceId = null, parentId = null } = {}) {
  const file = await pickFile('.md,.markdown,.txt,text/markdown,text/plain');
  if (!file) return null;
  if (file.size > 4 * 1024 * 1024) {
    toast('This file is too large to import as a page', { type: 'error' });
    return null;
  }
  try {
    const [text, editorModule] = await Promise.all([file.text(), import('../editor/index.js')]);
    const fallbackTitle = file.name.replace(/\.(md|markdown|txt)$/i, '');
    const { title, content } = editorModule.parseMarkdown(text, fallbackTitle);
    const page = await createPage({ workspaceId, parentId, title, content });
    if (page) toast(`Imported “${page.title || 'Untitled'}”`, { type: 'success', duration: 2500 });
    return page;
  } catch (error) {
    toastError(error, 'Could not import this file');
    return null;
  }
}

/** Offer `text` as a file download. */
export function downloadText(filename, text, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
