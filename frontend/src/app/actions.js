// Page operations shared by the sidebar, the page view and the palette.
import { api } from '../lib/api.js';
import { confirmDialog } from '../lib/modal.js';
import { toast, toastError } from '../lib/toast.js';
import { navigate, pagePath, parseRoute } from './router.js';
import {
  descendantIds,
  emit,
  getPage,
  pageTitle,
  refreshTree,
  store,
} from './store.js';
import { setExpanded } from './tree-state.js';

export async function createPage({ workspaceId = null, parentId = null, title = '' } = {}) {
  try {
    const page = await api.post('/api/pages', {
      workspace_id: parentId ? null : workspaceId,
      parent_id: parentId,
      title,
    });
    if (parentId) setExpanded(parentId, true);
    await refreshTree();
    await navigate(pagePath(page.id));
    return page;
  } catch (error) {
    toastError(error, 'Could not create the page');
    return null;
  }
}

export async function trashPage(pageId) {
  const page = getPage(pageId);
  const affected = new Set([pageId, ...descendantIds(pageId)]);
  try {
    await api.delete(`/api/pages/${pageId}`);
  } catch (error) {
    toastError(error, 'Could not delete the page');
    return;
  }
  const route = parseRoute();
  if (route.name === 'page' && affected.has(route.pageId)) {
    emit('page-gone');
    await navigate('/', { replace: true });
  }
  await refreshTree();
  toast(`“${pageTitle(page)}” moved to the recycle bin`, {
    action: { label: 'Undo', onClick: () => restorePage(pageId, { open: true }) },
    duration: 7000,
  });
}

export async function restorePage(pageId, { open = false } = {}) {
  try {
    await api.post(`/api/trash/${pageId}/restore`);
    await refreshTree();
    emit('trash-changed');
    if (open) await navigate(pagePath(pageId));
  } catch (error) {
    toastError(error, 'Could not restore the page');
  }
}

export async function purgePage(pageId, title) {
  const confirmed = await confirmDialog({
    title: 'Delete permanently?',
    message: `“${title || 'Untitled'}” and all of its sub-pages, versions and files will be deleted for good. This cannot be undone.`,
    confirmLabel: 'Delete permanently',
    danger: true,
  });
  if (!confirmed) return false;
  try {
    await api.delete(`/api/trash/${pageId}`);
    emit('trash-changed');
    return true;
  } catch (error) {
    toastError(error, 'Could not delete the page');
    return false;
  }
}

export async function duplicatePage(pageId) {
  try {
    const copy = await api.post(`/api/pages/${pageId}/duplicate`);
    await refreshTree();
    await navigate(pagePath(copy.id));
  } catch (error) {
    toastError(error, 'Could not duplicate the page');
  }
}

export async function toggleFavorite(pageId) {
  const favorite = !store.favorites.includes(pageId);
  // Optimistic: the star reacts immediately.
  store.favorites = favorite
    ? [...store.favorites, pageId]
    : store.favorites.filter((id) => id !== pageId);
  emit('tree');
  emit('favorite', { pageId, favorite });
  try {
    if (favorite) await api.put(`/api/pages/${pageId}/favorite`);
    else await api.delete(`/api/pages/${pageId}/favorite`);
  } catch (error) {
    toastError(error);
    await refreshTree();
    emit('favorite', { pageId, favorite: store.favorites.includes(pageId) });
  }
}

export async function renamePage(pageId, title) {
  try {
    const result = await api.patch(`/api/pages/${pageId}`, { title });
    const page = getPage(pageId);
    if (page) {
      page.title = result.title;
      emit('tree');
    }
    emit('page-renamed', { pageId, title: result.title });
  } catch (error) {
    toastError(error, 'Could not rename the page');
  }
}

export async function movePage(pageId, destination) {
  try {
    await api.post(`/api/pages/${pageId}/move`, destination);
    if (destination.parent_id) setExpanded(destination.parent_id, true);
    await refreshTree();
    emit('page-moved', { pageId });
    return true;
  } catch (error) {
    toastError(error, 'Could not move the page');
    return false;
  }
}

export async function copyPageLink(pageId) {
  const url = `${location.origin}${pagePath(pageId)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied', { type: 'success', duration: 2000 });
  } catch {
    toast(url);
  }
}

export async function signOut() {
  try {
    await api.post('/api/auth/logout');
  } finally {
    location.assign('/login');
  }
}
