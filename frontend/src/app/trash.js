// Recycle bin: restore or permanently delete pages.
import { api } from '../lib/api.js';
import { h, replace } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { confirmDialog } from '../lib/modal.js';
import { toast, toastError } from '../lib/toast.js';
import { timeAgo } from '../lib/util.js';
import { purgePage, restorePage } from './actions.js';
import { pagePath } from './router.js';
import { on } from './store.js';

export function mountTrash({ container, topbar }) {
  document.title = 'Recycle bin · MindDock';
  replace(topbar, h('nav', { class: 'breadcrumbs' }, h('span', { class: 'crumb' }, 'Recycle bin')));
  const list = h('div');
  const emptyButton = h(
    'button',
    { class: 'button button-small', type: 'button', hidden: true },
    'Empty recycle bin',
  );
  let destroyed = false;

  replace(
    container,
    h(
      'div',
      { class: 'listing' },
      h('div', { class: 'listing-head' }, h('h1', null, 'Recycle bin'), emptyButton),
      h(
        'p',
        { class: 'settings-desc' },
        'Deleted pages stay here, with their sub-pages and files, until you delete them permanently.',
      ),
      list,
    ),
  );

  async function load() {
    let items;
    try {
      items = await api.get('/api/trash');
    } catch (error) {
      toastError(error);
      return;
    }
    if (destroyed) return;
    emptyButton.hidden = !items.some((item) => item.can_purge);
    if (!items.length) {
      replace(
        list,
        h(
          'div',
          { class: 'empty' },
          icon('trash-2', 28),
          h('div', { class: 'empty-title' }, 'The recycle bin is empty'),
          h('div', null, 'Pages you delete will show up here.'),
        ),
      );
      return;
    }
    replace(
      list,
      items.map((item) =>
        h(
          'div',
          { class: 'list-row' },
          h('span', { class: 'tree-icon' }, item.icon || icon('file-text', 16)),
          h(
            'a',
            { class: 'list-main', href: pagePath(item.id), dataset: { link: '' } },
            h('div', { class: 'list-title' }, item.title || 'Untitled'),
            h(
              'div',
              { class: 'list-sub' },
              [
                `Deleted ${timeAgo(item.deleted_at)}`,
                item.deleted_by_name ? `by ${item.deleted_by_name}` : null,
                item.workspace_name && item.workspace_name !== 'Personal' ? item.workspace_name : null,
                item.nested_count
                  ? `${item.nested_count} sub-page${item.nested_count === 1 ? '' : 's'}`
                  : null,
              ]
                .filter(Boolean)
                .join(' · '),
            ),
          ),
          h(
            'div',
            { class: 'row-actions' },
            h(
              'button',
              { class: 'button button-small', type: 'button', onclick: () => restorePage(item.id) },
              icon('restore', 14),
              'Restore',
            ),
            item.can_purge
              ? h(
                  'button',
                  {
                    class: 'icon-button',
                    type: 'button',
                    title: 'Delete permanently',
                    'aria-label': `Delete ${item.title || 'Untitled'} permanently`,
                    onclick: () => purgePage(item.id, item.title),
                  },
                  icon('trash-2', 15),
                )
              : null,
          ),
        ),
      ),
    );
  }

  emptyButton.addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: 'Empty the recycle bin?',
      message: 'Every page in the recycle bin that you own will be deleted permanently, including versions and files. This cannot be undone.',
      confirmLabel: 'Delete everything',
      danger: true,
    });
    if (!confirmed) return;
    try {
      const result = await api.delete('/api/trash');
      toast(`${result.purged} page${result.purged === 1 ? '' : 's'} deleted permanently`);
      load();
    } catch (error) {
      toastError(error);
    }
  });

  const unsubscribe = on('trash-changed', load);
  load();
  return {
    flush: async () => {},
    destroy() {
      destroyed = true;
      unsubscribe();
    },
  };
}
