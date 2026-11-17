// A single page: top bar, cover, icon, title and the block editor.
import { api } from '../lib/api.js';
import { copyText } from '../lib/clipboard.js';
import { h, kbd, replace } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openMenu } from '../lib/menu.js';
import { promptDialog } from '../lib/modal.js';
import { toast, toastError } from '../lib/toast.js';
import { clamp, debounce, timeAgo } from '../lib/util.js';
import {
  createPage,
  copyPageLink,
  duplicatePage,
  purgePage,
  restorePage,
  toggleFavorite,
  trashPage,
} from './actions.js';
import { openEmojiPicker } from './emoji.js';
import { downloadText, importMarkdown } from './import.js';
import { navigate, pagePath } from './router.js';
import { DocSaver } from './saver.js';
import { emit, getPage, isFavorite, on, patchPage, store, userName } from './store.js';

const SAVE_LABELS = {
  saved: 'Saved',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  offline: 'Offline — will retry',
  error: 'Not saved',
  conflict: 'Conflict',
};

function isImageFile(file) {
  return /\.(png|jpe?g|webp|gif)$/i.test(file.name);
}

function pickImage() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: '.png,.jpg,.jpeg,.webp,.gif' });
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/**
 * Mount a page into `container`. Returns { flush, destroy }.
 * `shell` gives access to the top bar and application-level actions.
 */
export async function mountPageView({ container, topbar, pageId, shell, mountSignal }) {
  const controller = new AbortController();
  const { signal } = controller;
  const subscriptions = [];
  let destroyed = false;
  // The shell aborts `mountSignal` when the user navigates away mid-load.
  mountSignal.addEventListener('abort', () => {
    destroyed = true;
    controller.abort();
  });
  let editor = null;
  let saver = null;
  let page = null;

  const loadingTimer = setTimeout(() => {
    if (!page) replace(container, h('div', { class: 'page-loading' }, h('div', { class: 'boot-mark' })));
  }, 180);

  let editorModule;
  try {
    [page, editorModule] = await Promise.all([
      api.get(`/api/pages/${pageId}`, { signal }),
      import('../editor/index.js'),
    ]);
  } catch (error) {
    clearTimeout(loadingTimer);
    if (error?.name === 'AbortError' || destroyed) return { flush: async () => {}, destroy() {} };
    replace(topbar);
    replace(
      container,
      h(
        'div',
        { class: 'page-error' },
        h(
          'div',
          { class: 'empty' },
          icon(error.status === 404 ? 'lock' : 'offline', 28),
          h(
            'div',
            { class: 'empty-title' },
            error.status === 404 ? 'Page not found' : 'This page could not be loaded',
          ),
          h(
            'div',
            null,
            error.status === 404
              ? 'It may have been deleted, or you do not have access to it.'
              : error.message,
          ),
          h('a', { class: 'button', href: '/', dataset: { link: '' } }, 'Go home'),
        ),
      ),
    );
    return { flush: async () => {}, destroy: () => controller.abort() };
  }
  clearTimeout(loadingTimer);
  if (destroyed) return { flush: async () => {}, destroy() {} };

  const trashed = Boolean(page.deleted_at);
  const locked = Boolean(page.locked);
  // A locked page is read-only for everyone until it is unlocked.
  const editable = page.can_edit && !trashed && !locked;
  const canChange = page.can_edit && !trashed;

  // -- top bar --------------------------------------------------------------

  const saveState = h('span', { class: 'save-state', dataset: { state: 'saved' }, 'aria-live': 'polite' });
  const crumbs = h('nav', { class: 'breadcrumbs', 'aria-label': 'Breadcrumb' });
  const star = h(
    'button',
    { class: 'icon-button', type: 'button', onclick: () => toggleFavorite(page.id) },
    icon('star', 16),
  );

  function renderCrumbs() {
    const parts = [];
    if (page.workspace_name) {
      const label = page.workspace_name === 'Personal' ? 'Private' : page.workspace_name;
      parts.push(h('span', { class: 'crumb' }, h('span', { class: 'crumb-text' }, label)));
    }
    for (const crumb of page.breadcrumbs) {
      parts.push(
        h(
          'a',
          { class: 'crumb', href: pagePath(crumb.id), dataset: { link: '' } },
          crumb.icon ? h('span', { class: 'crumb-emoji' }, crumb.icon) : null,
          h('span', { class: 'crumb-text' }, crumb.title || 'Untitled'),
        ),
      );
    }
    parts.push(
      h(
        'span',
        { class: 'crumb', 'aria-current': 'page' },
        page.icon ? h('span', { class: 'crumb-emoji' }, page.icon) : null,
        h('span', { class: 'crumb-text' }, page.title || 'Untitled'),
      ),
    );
    replace(
      crumbs,
      parts.flatMap((part, index) =>
        index ? [h('span', { class: 'crumb-sep' }, '/'), part] : [part],
      ),
    );
  }

  function renderStar() {
    const favorite = isFavorite(page.id);
    star.classList.toggle('is-on', favorite);
    star.title = favorite ? 'Remove from favorites' : 'Add to favorites';
    star.setAttribute('aria-label', star.title);
    star.setAttribute('aria-pressed', String(favorite));
    star.firstChild.setAttribute('fill', favorite ? 'currentColor' : 'none');
  }

  function setSaveState(state, detail) {
    saveState.dataset.state = state;
    const iconName = { saving: 'loader', offline: 'offline', error: 'alert', conflict: 'alert' }[state];
    const iconEl = iconName ? icon(iconName, 14) : state === 'saved' ? icon('check', 14) : null;
    if (state === 'saving') iconEl.classList.add('spinner');
    replace(saveState, iconEl, h('span', { class: 'save-text' }, SAVE_LABELS[state]));
    saveState.title = detail && typeof detail === 'string' ? detail : SAVE_LABELS[state];
    if (state === 'conflict') showConflict(detail);
    if (state === 'error') toast(detail || 'Your changes could not be saved', { type: 'error' });
  }

  const moreButton = h(
    'button',
    { class: 'icon-button', type: 'button', title: 'More', 'aria-label': 'Page menu', 'aria-haspopup': 'menu' },
    icon('more', 16),
  );
  async function setMeta(fields, { reload = false } = {}) {
    const ok = await saveMeta(fields);
    if (ok && reload) shell.reloadPage();
    else if (ok) applyAppearance();
  }

  async function copyContents() {
    const markdown = editorModule.documentToMarkdown(editor, page.title);
    const html = `<h1>${page.title.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</h1>${editor.getHTML()}`;
    if (await copyText(markdown, html)) toast('Page contents copied', { type: 'success', duration: 2000 });
    else toast('Could not copy to the clipboard', { type: 'error' });
  }

  function exportMarkdown() {
    downloadText(
      editorModule.markdownFileName(page.title),
      editorModule.documentToMarkdown(editor, page.title),
    );
  }

  moreButton.addEventListener('click', () => {
    const fonts = [
      ['default', 'Default'],
      ['serif', 'Serif'],
      ['mono', 'Mono'],
    ];
    openMenu({
      anchor: moreButton,
      placement: 'bottom-end',
      items: [
        { label: 'Copy link', icon: 'link', onSelect: () => copyPageLink(page.id) },
        { label: 'Copy page contents', icon: 'clipboard-copy', onSelect: copyContents },
        { label: 'Duplicate', icon: 'copy', onSelect: () => duplicatePage(page.id) },
        editable ? { label: 'Move to…', icon: 'move', onSelect: () => shell.openMove(page.id) } : null,
        { separator: true },
        canChange
          ? {
              label: 'Appearance & layout',
              icon: 'text',
              disabled: locked,
              submenu: [
                { heading: 'Font' },
                ...fonts.map(([value, label]) => ({
                  label,
                  checked: page.font === value,
                  onSelect: () => setMeta({ font: value }),
                })),
                { separator: true },
                {
                  label: 'Small text',
                  checked: page.small_text,
                  onSelect: () => setMeta({ small_text: !page.small_text }),
                },
                {
                  label: 'Full width',
                  checked: page.full_width,
                  onSelect: () => setMeta({ full_width: !page.full_width }),
                },
              ],
            }
          : null,
        canChange
          ? {
              label: locked ? 'Unlock page' : 'Lock page',
              icon: locked ? 'unlock' : 'lock',
              onSelect: async () => {
                await flush();
                setMeta({ locked: !locked }, { reload: true });
              },
            }
          : null,
        {
          label: shell.isFocusMode() ? 'Exit focus mode' : 'Focus mode',
          icon: shell.isFocusMode() ? 'minimize' : 'maximize',
          hint: kbd('Mod+Shift+F'),
          onSelect: shell.toggleFocusMode,
        },
        { separator: true },
        { label: 'Export as Markdown', icon: 'file-down', onSelect: exportMarkdown },
        editable
          ? {
              label: 'Import Markdown as sub-page',
              icon: 'file-up',
              onSelect: () => importMarkdown({ parentId: page.id }),
            }
          : null,
        { label: 'Version history', icon: 'history', onSelect: openHistory },
        editable ? { label: 'Save a version…', icon: 'archive', onSelect: saveVersion } : null,
        { separator: true },
        {
          heading: `Edited ${timeAgo(page.updated_at)}${page.updated_by_name ? ` by ${page.updated_by_name}` : ''}`,
        },
        editable ? { separator: true } : null,
        editable
          ? { label: 'Delete', icon: 'trash-2', danger: true, onSelect: () => trashPage(page.id) }
          : null,
      ],
    });
  });

  replace(
    topbar,
    crumbs,
    h(
      'div',
      { class: 'topbar-actions' },
      editable ? saveState : null,
      !page.can_edit ? h('span', { class: 'badge' }, icon('eye', 12), 'View only') : null,
      trashed ? h('span', { class: 'badge' }, 'In recycle bin') : null,
      locked && !trashed
        ? h(
            page.can_edit ? 'button' : 'span',
            {
              class: 'badge lock-badge',
              type: page.can_edit ? 'button' : null,
              title: page.can_edit ? 'Unlock this page' : 'This page is locked',
              onclick: page.can_edit ? () => setMeta({ locked: false }, { reload: true }) : null,
            },
            icon('lock', 12),
            'Locked',
          )
        : null,
      trashed
        ? null
        : h(
            'button',
            {
              class: 'button button-ghost button-small',
              type: 'button',
              onclick: () => shell.openShare(page.id),
            },
            'Share',
          ),
      trashed ? null : star,
      h(
        'button',
        {
          class: 'icon-button',
          type: 'button',
          title: 'Version history',
          'aria-label': 'Version history',
          onclick: () => openHistory(),
        },
        icon('history', 16),
      ),
      moreButton,
      h(
        'button',
        {
          class: 'button button-small focus-exit',
          type: 'button',
          onclick: shell.toggleFocusMode,
        },
        'Exit focus',
      ),
    ),
  );

  // -- cover, icon, title ---------------------------------------------------

  const cover = h('div', { class: 'page-cover' });
  const headActions = h('div', { class: 'page-head-actions' });
  const iconSlot = h('div');
  const title = h('textarea', {
    class: 'page-title',
    rows: 1,
    placeholder: 'Untitled',
    value: page.title,
    readOnly: !editable,
    spellcheck: true,
    'aria-label': 'Page title',
    maxLength: 300,
  });
  const banners = h('div');
  const editorMount = h('div', { class: 'editor' });
  const head = h('div', { class: 'page-head' }, iconSlot, headActions, title);
  const article = h('article', { class: 'page' }, head, banners, editorMount);

  async function saveMeta(fields) {
    try {
      const result = await api.patch(`/api/pages/${page.id}`, fields);
      for (const key of [
        'title',
        'icon',
        'cover_attachment_id',
        'cover_position',
        'font',
        'small_text',
        'full_width',
        'locked',
      ]) {
        page[key] = result[key];
      }
      patchPage(page.id, { title: result.title, icon: result.icon });
      return true;
    } catch (error) {
      toastError(error, 'Could not update the page');
      return false;
    }
  }

  function applyAppearance() {
    article.classList.toggle('font-serif', page.font === 'serif');
    article.classList.toggle('font-mono', page.font === 'mono');
    article.classList.toggle('is-small', Boolean(page.small_text));
    article.classList.toggle('is-wide', Boolean(page.full_width));
  }

  /** Drag the cover up or down to choose which part of the picture shows. */
  function repositionCover() {
    const image = cover.querySelector('img');
    if (!image) return;
    const original = page.cover_position;
    let position = original;
    let drag = null;
    const session = new AbortController();
    const apply = () => {
      image.style.objectPosition = `center ${position}%`;
    };
    const finish = async (save) => {
      session.abort();
      cover.classList.remove('is-repositioning');
      if (save && position !== original) await saveMeta({ cover_position: Math.round(position) });
      renderHead();
    };

    cover.classList.add('is-repositioning');
    replace(
      cover,
      image,
      h('div', { class: 'cover-hint' }, 'Drag the image to reposition'),
      h(
        'div',
        { class: 'cover-actions' },
        h('button', { class: 'button button-small button-primary', type: 'button', onclick: () => finish(true) }, 'Save position'),
        h('button', { class: 'button button-small', type: 'button', onclick: () => finish(false) }, 'Cancel'),
      ),
    );
    cover.addEventListener(
      'pointerdown',
      (event) => {
        if (event.target.closest('button')) return;
        drag = { y: event.clientY, start: position };
        cover.setPointerCapture(event.pointerId);
      },
      { signal: session.signal },
    );
    cover.addEventListener(
      'pointermove',
      (event) => {
        if (!drag) return;
        // How far the picture can travel: its scaled height minus the frame.
        const scale = cover.clientWidth / (image.naturalWidth || cover.clientWidth);
        const overflow = Math.max(1, (image.naturalHeight || 0) * scale - cover.clientHeight);
        position = clamp(drag.start - ((event.clientY - drag.y) / overflow) * 100, 0, 100);
        apply();
      },
      { signal: session.signal },
    );
    cover.addEventListener('pointerup', () => (drag = null), { signal: session.signal });
    cover.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          position = clamp(position + (event.key === 'ArrowUp' ? -4 : 4), 0, 100);
          apply();
        } else if (event.key === 'Enter') finish(true);
        else if (event.key === 'Escape') finish(false);
      },
      { signal: session.signal },
    );
    cover.tabIndex = -1;
    cover.focus({ preventScroll: true });
  }

  async function chooseCover() {
    const file = await pickImage();
    if (!file) return;
    if (!isImageFile(file)) {
      toast('Covers must be PNG, JPG, WebP or GIF images', { type: 'error' });
      return;
    }
    try {
      const attachment = await api.upload(`/api/pages/${page.id}/files`, file);
      await saveMeta({ cover_attachment_id: attachment.id });
      renderHead();
    } catch (error) {
      toastError(error, 'Could not upload the cover');
    }
  }

  function chooseIcon(anchor) {
    openEmojiPicker({
      anchor,
      current: page.icon,
      onPick: async (emoji) => {
        page.icon = emoji;
        renderHead();
        renderCrumbs();
        await saveMeta({ icon: emoji });
      },
    });
  }

  function renderHead() {
    const hasCover = Boolean(page.cover_attachment_id);
    article.classList.toggle('has-cover', hasCover);
    head.classList.toggle('has-icon', Boolean(page.icon));
    cover.hidden = !hasCover;
    if (hasCover) {
      replace(
        cover,
        h('img', {
          src: `/api/files/${page.cover_attachment_id}`,
          alt: '',
          decoding: 'async',
          draggable: false,
          style: `object-position: center ${page.cover_position ?? 50}%`,
        }),
        editable
          ? h(
              'div',
              { class: 'cover-actions' },
              h('button', { class: 'button button-small', type: 'button', onclick: chooseCover }, 'Change cover'),
              h('button', { class: 'button button-small', type: 'button', onclick: repositionCover }, 'Reposition'),
              h(
                'button',
                {
                  class: 'button button-small',
                  type: 'button',
                  onclick: async () => {
                    await saveMeta({ cover_attachment_id: null });
                    renderHead();
                  },
                },
                'Remove',
              ),
            )
          : null,
      );
    } else {
      replace(cover);
    }

    if (page.icon) {
      const button = h(
        editable ? 'button' : 'div',
        { class: 'page-icon', type: editable ? 'button' : null, title: editable ? 'Change icon' : null },
        page.icon,
      );
      if (editable) button.addEventListener('click', () => chooseIcon(button));
      replace(iconSlot, button);
    } else {
      replace(iconSlot);
    }

    const addIcon = h(
      'button',
      { class: 'button button-ghost button-small', type: 'button' },
      icon('smile', 14),
      'Add icon',
    );
    addIcon.addEventListener('click', () => chooseIcon(addIcon));
    replace(
      headActions,
      editable && !page.icon ? addIcon : null,
      editable && !hasCover
        ? h(
            'button',
            { class: 'button button-ghost button-small', type: 'button', onclick: chooseCover },
            icon('image-plus', 14),
            'Add cover',
          )
        : null,
    );
  }

  function resizeTitle() {
    title.style.height = 'auto';
    title.style.height = `${title.scrollHeight}px`;
  }

  const saveTitle = debounce(() => saveMeta({ title: title.value }), 500);
  title.addEventListener('input', () => {
    // Titles are single-line.
    if (title.value.includes('\n')) title.value = title.value.replace(/\n+/g, ' ');
    resizeTitle();
    page.title = title.value.trim();
    document.title = `${page.title || 'Untitled'} · KamiSpace`;
    patchPage(page.id, { title: page.title });
    renderCrumbs();
    saveTitle();
  });
  title.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === 'ArrowDown') {
      event.preventDefault();
      if (editor) editorModule.focusEditorStart(editor);
    }
  });

  // -- banners --------------------------------------------------------------

  function showConflict(info) {
    const who = info?.updated_by_name ? ` by ${info.updated_by_name}` : '';
    const when = info?.updated_at ? ` ${timeAgo(info.updated_at)}` : '';
    replace(
      banners,
      h(
        'div',
        { class: 'page-banner is-danger', role: 'alert' },
        h(
          'div',
          { class: 'page-banner-text' },
          h('strong', null, 'This page was changed somewhere else'),
          `${who}${when}. Your latest edits are not saved yet — choose which version to keep. `,
          'The other one stays available in the version history.',
        ),
        h(
          'button',
          {
            class: 'button button-small',
            type: 'button',
            onclick: () => shell.reloadPage(),
          },
          'Load their version',
        ),
        h(
          'button',
          {
            class: 'button button-small button-primary',
            type: 'button',
            onclick: async () => {
              replace(banners);
              await saver.overwrite();
            },
          },
          'Keep my version',
        ),
      ),
    );
  }

  if (trashed) {
    replace(
      banners,
      h(
        'div',
        { class: 'page-banner' },
        h('div', { class: 'page-banner-text' }, 'This page is in the recycle bin.'),
        page.can_edit
          ? h(
              'button',
              {
                class: 'button button-small',
                type: 'button',
                onclick: async () => {
                  await restorePage(page.id);
                  shell.reloadPage();
                },
              },
              'Restore',
            )
          : null,
        page.can_manage
          ? h(
              'button',
              {
                class: 'button button-small button-danger',
                type: 'button',
                onclick: async () => {
                  if (await purgePage(page.id, page.title)) navigate('/trash', { replace: true });
                },
              },
              'Delete permanently',
            )
          : null,
      ),
    );
  }

  // -- editor ---------------------------------------------------------------

  replace(container, cover, article);
  renderHead();
  renderCrumbs();
  renderStar();
  resizeTitle();
  document.title = `${page.title || 'Untitled'} · KamiSpace`;
  // A new page starts at the top, without animating from the old position.
  container.scrollTo({ top: 0, behavior: 'instant' });

  const context = {
    pageId: page.id,
    getPage: (id) => getPage(id),
    listPages: () => [...store.pages.values()],
    openPage: (id) => navigate(pagePath(id)),
    // Sub-pages made from inside the editor are linked where the caret is,
    // so the server must not add a second link at the end of the page.
    createSubPage: (title) =>
      createPage({ parentId: page.id, title, open: false, linkInParent: false }),
    subscribe: (listener) => on('tree', listener),
    listUsers: () => [...store.users].map(([id, username]) => ({ id, username })),
    userName,
    remoteFetch: Boolean(store.limits.remote_fetch),
    fetchBookmark: (url) => api.post('/api/bookmarks', { url }),
    importImage: (url) => api.post(`/api/pages/${page.id}/files/remote`, { url }),
  };
  editor = editorModule.createEditor({
    element: editorMount,
    content: page.content,
    editable,
    context,
    limits: store.limits,
    upload: (file) => api.upload(`/api/pages/${page.id}/files`, file),
    onChange: () => saver?.touch(),
    onExitTop: () => {
      title.focus();
      title.setSelectionRange(title.value.length, title.value.length);
    },
  });
  applyAppearance();

  if (editable) {
    saver = new DocSaver({
      pageId: page.id,
      revision: page.revision,
      getContent: () => editor.getJSON(),
      onState: setSaveState,
    });
    setSaveState('saved');
  }

  // A brand new page: start with the title.
  if (editable && !page.title && editor.isEmpty) title.focus();

  // -- staying fresh --------------------------------------------------------

  async function refreshIfStale() {
    if (destroyed || document.hidden || trashed) return;
    if (saver?.hasUnsavedChanges() || saver?.conflict) return;
    try {
      const latest = await api.get(`/api/pages/${page.id}`, { signal });
      if (destroyed || saver?.hasUnsavedChanges()) return;
      const currentRevision = saver ? saver.revision : page.revision;
      if (latest.revision !== currentRevision) {
        // Someone else saved meanwhile and we have nothing unsaved: follow.
        editor.commands.setContent(latest.content, { emitUpdate: false });
        saver?.reset(latest.revision);
        page.revision = latest.revision;
        toast('Updated with the latest changes', { duration: 2500 });
      }
      if (latest.title !== page.title && document.activeElement !== title) {
        page.title = latest.title;
        title.value = latest.title;
        resizeTitle();
        renderCrumbs();
        patchPage(page.id, { title: latest.title });
      }
    } catch {
      // Offline or the page disappeared; the next action will surface it.
    }
  }
  document.addEventListener('visibilitychange', refreshIfStale, { signal });
  window.addEventListener('focus', refreshIfStale, { signal });

  window.addEventListener(
    'beforeunload',
    (event) => {
      if (saver?.hasUnsavedChanges() || saveTitle.pending()) {
        saveTitle.flush();
        saver?.flush();
        event.preventDefault();
        event.returnValue = '';
      }
    },
    { signal },
  );

  subscriptions.push(
    on('favorite', ({ pageId: id }) => {
      if (id === page.id) renderStar();
    }),
    on('page-renamed', ({ pageId: id, title: newTitle }) => {
      if (id === page.id && document.activeElement !== title) {
        page.title = newTitle;
        title.value = newTitle;
        resizeTitle();
        renderCrumbs();
      }
    }),
    on('page-moved', ({ pageId: id }) => {
      if (id === page.id) shell.reloadPage();
    }),
    // Something outside the editor changed this page (a sub-page link was
    // added, a task was ticked in "My tasks"): pick it up.
    on('page-content-changed', ({ pageId: id }) => {
      if (id === page.id) refreshIfStale();
    }),
  );

  // -- versions -------------------------------------------------------------

  async function flush() {
    saveTitle.flush();
    await saver?.flush();
  }

  async function openHistory() {
    await flush();
    const { openHistoryDialog } = await import('./history.js');
    openHistoryDialog({
      page,
      canRestore: editable,
      createEditor: editorModule.createEditor,
      onRestored: () => {
        emit('tree-stale');
        shell.reloadPage();
      },
    });
  }

  async function saveVersion() {
    const description = await promptDialog({
      title: 'Save a version',
      label: 'What changed? (optional)',
      placeholder: 'e.g. Before the big rewrite',
      confirmLabel: 'Save version',
      required: false,
    });
    if (description === null) return;
    try {
      await flush();
      await api.post(`/api/pages/${page.id}/versions`, { description });
      toast('Version saved', { type: 'success', duration: 2500 });
    } catch (error) {
      toastError(error, 'Could not save a version');
    }
  }

  return {
    flush,
    focusEditor: () => editor?.commands.focus(),
    destroy() {
      destroyed = true;
      controller.abort();
      for (const unsubscribe of subscriptions) unsubscribe();
      saveTitle.cancel();
      saver?.destroy();
      editor?.destroy();
      editor = null;
    },
  };
}
