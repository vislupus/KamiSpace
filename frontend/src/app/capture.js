// Quick Capture: jot something down without leaving what you are doing.
import { api } from '../lib/api.js';
import { h, kbd } from '../lib/dom.js';
import { openModal } from '../lib/modal.js';
import { toast, toastError } from '../lib/toast.js';
import { navigate, pagePath } from './router.js';
import { refreshTree } from './store.js';

let open = false;

export function openCapture() {
  if (open) return;
  open = true;
  const text = h('textarea', {
    class: 'textarea capture-text',
    placeholder: 'What’s on your mind? The first line becomes the title.',
    autofocus: true,
    'aria-label': 'Quick note',
  });
  const save = h('button', { class: 'button button-primary', type: 'submit' }, 'Save to Inbox');

  async function submit() {
    const value = text.value.trim();
    if (!value) {
      text.focus();
      return;
    }
    save.disabled = true;
    try {
      const page = await api.post('/api/capture', { text: value });
      modal.close();
      await refreshTree();
      toast('Saved to your Inbox', {
        type: 'success',
        action: { label: 'Open', onClick: () => navigate(pagePath(page.id)) },
      });
    } catch (error) {
      save.disabled = false;
      toastError(error, 'Could not save the note');
    }
  }

  const form = h(
    'form',
    {
      class: 'form',
      onsubmit: (event) => {
        event.preventDefault();
        submit();
      },
    },
    text,
    h(
      'div',
      { class: 'modal-actions', style: 'align-items: center; margin-top: 4px' },
      h('span', { class: 'field-hint', style: 'margin-right: auto' }, `${kbd('Mod+Enter')} to save`),
      h('button', { class: 'button', type: 'button', onclick: () => modal.close() }, 'Cancel'),
      save,
    ),
  );
  text.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  });
  const modal = openModal({
    title: 'Quick capture',
    content: form,
    onClose: () => {
      open = false;
    },
  });
  text.focus();
}
