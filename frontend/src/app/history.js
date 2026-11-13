// Version history: browse snapshots, preview them read-only, restore one.
import { api } from '../lib/api.js';
import { h, replace } from '../lib/dom.js';
import { confirmDialog, openModal } from '../lib/modal.js';
import { toast, toastError } from '../lib/toast.js';
import { formatDate, timeAgo } from '../lib/util.js';

const KIND_LABEL = { manual: 'Saved', restore: 'Restored' };

export async function openHistoryDialog({ page, canRestore, createEditor, onRestored }) {
  const list = h('div', { class: 'history-list' });
  const previewTitle = h('div', { class: 'history-preview-title' });
  const previewMount = h('div', { class: 'editor' });
  const preview = h('div', { class: 'history-preview' }, previewTitle, previewMount);
  const restoreButton = h(
    'button',
    { class: 'button button-primary', type: 'button', disabled: true },
    'Restore this version',
  );
  const note = h('div', { class: 'field-hint' });
  let versions = [];
  let selected = null;
  let previewEditor = null;

  const modal = openModal({
    title: 'Version history',
    className: 'history',
    content: [
      preview,
      h(
        'div',
        { class: 'history-side' },
        list,
        canRestore ? h('div', { class: 'history-actions' }, restoreButton, note) : null,
      ),
    ],
    onClose: () => {
      previewEditor?.destroy();
      previewEditor = null;
    },
  });

  function renderList() {
    replace(
      list,
      versions.map((version, index) => {
        const label = KIND_LABEL[version.kind];
        const item = h(
          'button',
          {
            class: `history-item${selected?.id === version.id ? ' is-active' : ''}`,
            type: 'button',
            onclick: () => select(version),
          },
          h(
            'div',
            { class: 'history-item-title' },
            formatDate(version.updated_at, true),
            index === 0 ? h('span', { class: 'badge badge-accent' }, 'Current') : null,
            label ? h('span', { class: 'badge' }, label) : null,
          ),
          h(
            'div',
            { class: 'history-item-sub' },
            `v${version.number} · ${version.author_name} · ${timeAgo(version.updated_at)}`,
          ),
          version.description
            ? h('div', { class: 'history-item-sub' }, version.description)
            : null,
        );
        return item;
      }),
    );
  }

  async function select(version) {
    selected = version;
    renderList();
    restoreButton.disabled = true;
    try {
      const detail = await api.get(`/api/pages/${page.id}/versions/${version.id}`);
      if (selected?.id !== version.id) return;
      previewTitle.textContent = detail.title || 'Untitled';
      previewEditor?.destroy();
      replace(previewMount);
      previewEditor = createEditor({
        element: previewMount,
        content: detail.content,
        editable: false,
      });
      preview.scrollTop = 0;
      const isCurrent = versions[0]?.id === version.id;
      restoreButton.disabled = isCurrent;
      note.textContent = isCurrent
        ? 'This is the current version.'
        : 'Restoring adds a new version; nothing in the history is lost.';
    } catch (error) {
      toastError(error);
    }
  }

  restoreButton.addEventListener('click', async () => {
    if (!selected) return;
    const confirmed = await confirmDialog({
      title: `Restore version ${selected.number}?`,
      message: 'The page will go back to this version. The current content stays in the history.',
      confirmLabel: 'Restore',
    });
    if (!confirmed) return;
    try {
      await api.post(`/api/pages/${page.id}/versions/${selected.id}/restore`);
      modal.close();
      toast(`Restored version ${selected.number}`, { type: 'success' });
      onRestored();
    } catch (error) {
      toastError(error, 'Could not restore this version');
    }
  });

  try {
    versions = await api.get(`/api/pages/${page.id}/versions`);
  } catch (error) {
    modal.close();
    toastError(error);
    return;
  }
  if (!versions.length) {
    replace(
      preview,
      h(
        'div',
        { class: 'empty' },
        h('div', { class: 'empty-title' }, 'No versions yet'),
        h('div', null, 'Versions are created automatically as the page is edited.'),
      ),
    );
    return;
  }
  renderList();
  select(versions[0]);
}
