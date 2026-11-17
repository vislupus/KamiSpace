// What the editor needs to know about the rest of the application: other
// pages (for links and mentions) and people (for assigning tasks). The page
// view passes these in, so the editor itself stays independent of the app.
import { Extension } from '@tiptap/core';

const EMPTY = {
  /** id of the page being edited */
  pageId: null,
  /** (id) => { id, title, icon } | null — only pages the user may see */
  getPage: () => null,
  /** () => Array<{ id, title, icon }> */
  listPages: () => [],
  /** (id) => void — navigate to a page */
  openPage: () => {},
  /** (title) => Promise<{ id } | null> — create a page inside the current one */
  createSubPage: async () => null,
  /** (listener) => unsubscribe — called whenever titles or icons change */
  subscribe: () => () => {},
  /** () => Array<{ id, username }> */
  listUsers: () => [],
  /** (id) => string | null */
  userName: () => null,
  /** whether the server may fetch web addresses (bookmark previews, images) */
  remoteFetch: false,
  /** (url) => Promise<{ url, title, description }> */
  fetchBookmark: async () => null,
  /** (url) => Promise<attachment> — copy a web image into the page */
  importImage: async () => null,
};

export const AppContext = Extension.create({
  name: 'appContext',
  addOptions() {
    return { ...EMPTY };
  },
});

export function appContext(editor) {
  const extension = editor.extensionManager.extensions.find((ext) => ext.name === 'appContext');
  return extension ? extension.options : EMPTY;
}
