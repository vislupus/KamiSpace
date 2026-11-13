// Client-side state shared by the views: the signed-in user and the page tree.
import { api, setCsrfToken } from '../lib/api.js';

const listeners = new Map();

export const store = {
  user: null,
  workspaces: [],
  /** @type {Map<number, object>} page id → { id, parent_id, workspace_id, title, icon, position, role, shared } */
  pages: new Map(),
  favorites: [],
  recents: [],
  limits: { max_upload_bytes: 0, upload_extensions: [] },
  currentPageId: null,
};

export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event)?.delete(handler);
}

export function emit(event, payload) {
  for (const handler of listeners.get(event) ?? []) handler(payload);
}

function applyTree(data) {
  store.workspaces = data.workspaces;
  store.pages = new Map(data.pages.map((page) => [page.id, page]));
  store.favorites = data.favorites;
  store.recents = data.recents;
}

export async function loadBootstrap() {
  const data = await api.get('/api/bootstrap');
  store.user = data.user;
  store.limits = data.limits;
  setCsrfToken(data.csrf_token);
  applyTree(data);
  emit('tree');
}

export async function refreshTree() {
  applyTree(await api.get('/api/tree'));
  emit('tree');
}

export function getPage(id) {
  return store.pages.get(id) ?? null;
}

export function pageTitle(page) {
  return page?.title || 'Untitled';
}

function byPosition(a, b) {
  return a.position - b.position || a.id - b.id;
}

/** Children of a page, or the top-level pages of a workspace section. */
export function childrenOf(parentId) {
  const result = [];
  for (const page of store.pages.values()) {
    if (page.parent_id === parentId) result.push(page);
  }
  return result.sort(byPosition);
}

export function rootPages(workspaceId) {
  const result = [];
  for (const page of store.pages.values()) {
    if (page.parent_id === null && page.workspace_id === workspaceId && !page.shared) {
      result.push(page);
    }
  }
  return result.sort(byPosition);
}

/** Roots of subtrees that were shared with the user by somebody else. */
export function sharedRoots() {
  const result = [];
  for (const page of store.pages.values()) {
    if (page.shared && page.parent_id === null) result.push(page);
  }
  return result.sort((a, b) => pageTitle(a).localeCompare(pageTitle(b)));
}

export function hasChildren(pageId) {
  for (const page of store.pages.values()) {
    if (page.parent_id === pageId) return true;
  }
  return false;
}

export function ancestorsOf(pageId) {
  const chain = [];
  const seen = new Set([pageId]);
  let current = store.pages.get(pageId);
  while (current && current.parent_id !== null && !seen.has(current.parent_id)) {
    seen.add(current.parent_id);
    current = store.pages.get(current.parent_id);
    if (current) chain.unshift(current);
  }
  return chain;
}

export function descendantIds(pageId) {
  const ids = [];
  const queue = [pageId];
  while (queue.length) {
    const id = queue.pop();
    for (const page of store.pages.values()) {
      if (page.parent_id === id) {
        ids.push(page.id);
        queue.push(page.id);
      }
    }
  }
  return ids;
}

/** Optimistic local update, e.g. while the title is being typed. */
export function patchPage(id, changes) {
  const page = store.pages.get(id);
  if (!page) return;
  Object.assign(page, changes);
  emit('tree');
}

export function isFavorite(id) {
  return store.favorites.includes(id);
}

export function personalWorkspace() {
  return store.workspaces.find((workspace) => workspace.kind === 'personal') ?? null;
}

export function canCreateIn(workspace) {
  return workspace && (workspace.role === 'owner' || workspace.role === 'editor');
}
