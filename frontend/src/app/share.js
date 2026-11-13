// Share a page with specific people.
import { api } from '../lib/api.js';
import { h, replace } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openModal } from '../lib/modal.js';
import { toastError } from '../lib/toast.js';
import { debounce, initials } from '../lib/util.js';
import { getPage, pageTitle, store } from './store.js';

function roleSelect(value, onChange, { allowRemove = true } = {}) {
  const select = h(
    'select',
    { class: 'select', 'aria-label': 'Access level' },
    h('option', { value: 'viewer' }, 'Can view'),
    h('option', { value: 'editor' }, 'Can edit'),
    allowRemove ? h('option', { value: 'remove' }, 'Remove access') : null,
  );
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function person(user, trailing, sub) {
  return h(
    'div',
    { class: 'list-row' },
    h('span', { class: 'avatar' }, initials(user.display_name)),
    h(
      'div',
      { class: 'list-main' },
      h('div', { class: 'list-title' }, user.display_name),
      h('div', { class: 'list-sub' }, sub ?? `@${user.username}`),
    ),
    trailing,
  );
}

export async function openShareDialog(pageId) {
  const page = getPage(pageId);
  const body = h('div', null, h('div', { class: 'empty' }, h('div', { class: 'boot-mark' })));
  const modal = openModal({ title: `Share “${pageTitle(page)}”`, content: body });

  let data;
  try {
    data = await api.get(`/api/pages/${pageId}/shares`);
  } catch (error) {
    modal.close();
    toastError(error);
    return;
  }

  const input = h('input', {
    class: 'input',
    placeholder: 'Add people by name or username…',
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': 'Find people',
  });
  const newRole = roleSelect('viewer', () => {}, { allowRemove: false });
  const suggestions = h('div', { class: 'share-suggestions' });
  const list = h('div', { class: 'share-list' });

  async function update(call) {
    try {
      data = await call();
      render();
    } catch (error) {
      toastError(error);
      render();
    }
  }

  function render() {
    const rows = [];
    for (const share of data.direct) {
      rows.push(
        person(
          share,
          data.can_manage
            ? roleSelect(share.role, (role) =>
                update(() =>
                  role === 'remove'
                    ? api.delete(`/api/pages/${pageId}/shares/${share.user_id}`)
                    : api.put(`/api/pages/${pageId}/shares/${share.user_id}`, { role }),
                ),
              )
            : h('span', { class: 'badge' }, share.role === 'editor' ? 'Can edit' : 'Can view'),
        ),
      );
    }
    for (const share of data.inherited) {
      rows.push(
        person(
          share,
          h('span', { class: 'badge' }, share.role === 'editor' ? 'Can edit' : 'Can view'),
          `Inherited from “${share.from_title}”`,
        ),
      );
    }
    replace(
      list,
      rows.length ? [h('div', { class: 'section-title' }, 'People with access'), rows] : null,
    );
  }

  const lookup = debounce(async (query) => {
    if (!query) {
      replace(suggestions);
      return;
    }
    try {
      const people = await api.get(`/api/users?q=${encodeURIComponent(query)}`);
      if (input.value.trim() !== query) return;
      const existing = new Set(data.direct.map((share) => share.user_id));
      const candidates = people.filter(
        (user) => user.id !== store.user.id && !existing.has(user.id),
      );
      replace(
        suggestions,
        candidates.length
          ? candidates.map((user) => {
              const row = person(user, icon('plus', 15));
              row.style.cursor = 'pointer';
              row.tabIndex = 0;
              row.setAttribute('role', 'button');
              const add = () => {
                input.value = '';
                replace(suggestions);
                update(() =>
                  api.put(`/api/pages/${pageId}/shares/${user.id}`, { role: newRole.value }),
                );
              };
              row.addEventListener('click', add);
              row.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') add();
              });
              return row;
            })
          : h('div', { class: 'palette-empty' }, 'No matching people'),
      );
    } catch (error) {
      toastError(error);
    }
  }, 150);
  input.addEventListener('input', () => lookup(input.value.trim()));

  const workspace = data.workspace;
  const note =
    workspace.kind === 'personal'
      ? [icon('lock', 15), 'Private page — only you and the people listed here can open it.']
      : [
          icon('users', 15),
          `Everyone in ${workspace.name} (${workspace.member_count} member${workspace.member_count === 1 ? '' : 's'}) can open this page.`,
        ];

  replace(
    body,
    data.can_manage
      ? [h('div', { class: 'share-add' }, input, newRole), suggestions]
      : h('p', { class: 'settings-desc' }, 'Only the page owner can change who has access.'),
    list,
    h('div', { class: 'share-note' }, note),
    h(
      'p',
      { class: 'field-hint', style: 'margin-top: 8px' },
      'Access also applies to all pages nested inside this one.',
    ),
  );
  render();
  if (data.can_manage) input.focus();
}
