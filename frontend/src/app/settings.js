// Settings: account, appearance, workspaces and (for administrators) users,
// invitations, backups and the audit log. Loaded on demand.
import { api } from '../lib/api.js';
import { h, replace } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openMenu } from '../lib/menu.js';
import { confirmDialog, openModal, promptDialog } from '../lib/modal.js';
import { getThemeChoice, setThemeChoice } from '../lib/theme.js';
import { toast, toastError } from '../lib/toast.js';
import { debounce, formatBytes, formatDate, timeAgo } from '../lib/util.js';
import { refreshTree, store } from './store.js';

function field(label, attributes = {}) {
  const input = h('input', { class: 'input', ...attributes });
  return { input, el: h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input) };
}

function formError() {
  return h('div', { class: 'form-error', role: 'alert' });
}

async function guarded(action, errorBox) {
  if (errorBox) errorBox.textContent = '';
  try {
    return await action();
  } catch (error) {
    if (errorBox) errorBox.textContent = error.message;
    else toastError(error);
    return undefined;
  }
}

// -- Account -----------------------------------------------------------------

function accountPane(pane) {
  const name = field('Name', { value: store.user.display_name, maxLength: 120 });
  const email = field('Email', { value: store.user.email, type: 'email' });
  const profileError = formError();
  const profile = h(
    'form',
    {
      class: 'form settings-form',
      onsubmit: async (event) => {
        event.preventDefault();
        const user = await guarded(
          () => api.patch('/api/account', { display_name: name.input.value, email: email.input.value }),
          profileError,
        );
        if (user) {
          store.user = user;
          toast('Profile updated', { type: 'success', duration: 2000 });
        }
      },
    },
    field('Username', { value: store.user.username, disabled: true }).el,
    name.el,
    email.el,
    profileError,
    h('div', null, h('button', { class: 'button button-primary', type: 'submit' }, 'Save')),
  );

  const current = field('Current password', { type: 'password', autocomplete: 'current-password', required: true });
  const next = field('New password', { type: 'password', autocomplete: 'new-password', required: true, minLength: 8 });
  const passwordError = formError();
  const password = h(
    'form',
    {
      class: 'form settings-form',
      onsubmit: async (event) => {
        event.preventDefault();
        const ok = await guarded(
          () =>
            api.post('/api/account/password', {
              current_password: current.input.value,
              new_password: next.input.value,
            }),
          passwordError,
        );
        if (ok) {
          current.input.value = '';
          next.input.value = '';
          toast('Password changed. Other devices were signed out.', { type: 'success' });
          loadSessions();
        }
      },
    },
    current.el,
    next.el,
    h('span', { class: 'field-hint' }, 'At least 8 characters. Changing it signs out your other devices.'),
    passwordError,
    h('div', null, h('button', { class: 'button', type: 'submit' }, 'Change password')),
  );

  const sessions = h('div');
  async function loadSessions() {
    const rows = await guarded(() => api.get('/api/account/sessions'));
    if (!rows) return;
    replace(
      sessions,
      rows.map((session) =>
        h(
          'div',
          { class: 'list-row' },
          icon('monitor', 16),
          h(
            'div',
            { class: 'list-main' },
            h(
              'div',
              { class: 'list-title' },
              session.user_agent ? describeAgent(session.user_agent) : 'Unknown device',
              session.current ? h('span', { class: 'badge badge-accent', style: 'margin-left: 8px' }, 'This device') : null,
            ),
            h('div', { class: 'list-sub' }, `${session.ip ?? ''} · active ${timeAgo(session.last_seen_at)}`),
          ),
          session.current
            ? null
            : h(
                'button',
                {
                  class: 'button button-small',
                  type: 'button',
                  onclick: async () => {
                    await guarded(() => api.delete(`/api/account/sessions/${session.id}`));
                    loadSessions();
                  },
                },
                'Sign out',
              ),
        ),
      ),
    );
  }

  replace(
    pane,
    h('h3', null, 'Profile'),
    profile,
    h('h3', null, 'Password'),
    password,
    h('h3', null, 'Signed-in devices'),
    sessions,
  );
  loadSessions();
}

function describeAgent(agent) {
  const browser = /Firefox\//.test(agent)
    ? 'Firefox'
    : /Edg\//.test(agent)
      ? 'Edge'
      : /Chrome\//.test(agent)
        ? 'Chrome'
        : /Safari\//.test(agent)
          ? 'Safari'
          : 'Browser';
  const system = /Windows/.test(agent)
    ? 'Windows'
    : /Mac OS X/.test(agent)
      ? 'macOS'
      : /Android/.test(agent)
        ? 'Android'
        : /iPhone|iPad/.test(agent)
          ? 'iOS'
          : /Linux/.test(agent)
            ? 'Linux'
            : '';
  return system ? `${browser} on ${system}` : browser;
}

// -- Appearance --------------------------------------------------------------

function appearancePane(pane) {
  const options = [
    ['light', 'Light', 'sun'],
    ['dark', 'Dark', 'moon'],
    ['system', 'System', 'monitor'],
  ];
  const group = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Theme' });
  const render = () => {
    replace(
      group,
      options.map(([value, label, iconName]) =>
        h(
          'button',
          {
            type: 'button',
            'aria-pressed': String(getThemeChoice() === value),
            onclick: () => {
              setThemeChoice(value);
              render();
            },
          },
          icon(iconName, 15),
          label,
        ),
      ),
    );
  };
  render();
  replace(
    pane,
    h('h3', null, 'Theme'),
    h('p', { class: 'settings-desc' }, 'Choose how MindDock looks on this device.'),
    group,
  );
}

// -- Workspaces --------------------------------------------------------------

function memberPicker(onPick, excluded) {
  const input = h('input', { class: 'input', placeholder: 'Add a member by name…', autocomplete: 'off' });
  const suggestions = h('div', { class: 'share-suggestions' });
  const lookup = debounce(async (query) => {
    if (!query) {
      replace(suggestions);
      return;
    }
    const people = await guarded(() => api.get(`/api/users?q=${encodeURIComponent(query)}`));
    if (!people || input.value.trim() !== query) return;
    const candidates = people.filter((user) => !excluded().has(user.id));
    replace(
      suggestions,
      candidates.length
        ? candidates.map((user) =>
            h(
              'button',
              {
                class: 'menu-item',
                type: 'button',
                style: 'width: 100%; text-align: left',
                onclick: () => {
                  input.value = '';
                  replace(suggestions);
                  onPick(user);
                },
              },
              icon('user-plus', 15),
              h('span', { class: 'menu-label' }, `${user.display_name} (@${user.username})`),
            ),
          )
        : h('div', { class: 'palette-empty' }, 'No matching people'),
    );
  }, 150);
  input.addEventListener('input', () => lookup(input.value.trim()));
  return h('div', null, input, suggestions);
}

function workspacesPane(pane) {
  const isAdmin = store.user.is_admin;
  const list = h('div');
  const detail = h('div');

  async function load() {
    const workspaces = isAdmin
      ? await guarded(() => api.get('/api/admin/workspaces'))
      : store.workspaces.filter((workspace) => workspace.kind === 'team');
    if (!workspaces) return;
    replace(
      list,
      workspaces.length
        ? workspaces.map((workspace) =>
            h(
              'div',
              { class: 'list-row' },
              icon('building', 16),
              h(
                'div',
                { class: 'list-main' },
                h('div', { class: 'list-title' }, workspace.name),
                h(
                  'div',
                  { class: 'list-sub' },
                  [
                    workspace.role ? `You are ${workspace.role}` : 'You are not a member',
                    workspace.member_count !== undefined
                      ? `${workspace.member_count} member${workspace.member_count === 1 ? '' : 's'}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                ),
              ),
              h(
                'button',
                { class: 'button button-small', type: 'button', onclick: () => openWorkspace(workspace) },
                workspace.role === 'owner' || isAdmin ? 'Manage' : 'Members',
              ),
            ),
          )
        : h(
            'div',
            { class: 'empty' },
            icon('users', 26),
            h('div', { class: 'empty-title' }, 'No team workspaces yet'),
            h(
              'div',
              null,
              isAdmin
                ? 'Create one to share a space with your colleagues.'
                : 'An administrator can create one and add you to it.',
            ),
          ),
    );
  }

  async function openWorkspace(workspace) {
    const canManage = workspace.role === 'owner' || isAdmin;
    const members = await guarded(() => api.get(`/api/workspaces/${workspace.id}/members`));
    if (!members) return;
    let current = members;

    const table = h('div');
    const apply = async (call) => {
      const updated = await guarded(call);
      if (updated) {
        current = updated;
        renderMembers();
        await refreshTree();
        load();
      }
    };

    function renderMembers() {
      replace(
        table,
        current.map((member) => {
          const select = h(
            'select',
            { class: 'select', disabled: !canManage, 'aria-label': `Role of ${member.display_name}` },
            h('option', { value: 'viewer' }, 'Viewer'),
            h('option', { value: 'editor' }, 'Editor'),
            h('option', { value: 'owner' }, 'Owner'),
          );
          select.value = member.role;
          select.addEventListener('change', () =>
            apply(() =>
              api.put(`/api/workspaces/${workspace.id}/members/${member.user_id}`, { role: select.value }),
            ).then(() => {
              select.value = current.find((m) => m.user_id === member.user_id)?.role ?? member.role;
            }),
          );
          return h(
            'div',
            { class: 'list-row' },
            h(
              'div',
              { class: 'list-main' },
              h('div', { class: 'list-title' }, member.display_name),
              h('div', { class: 'list-sub' }, `@${member.username}${member.is_active ? '' : ' · deactivated'}`),
            ),
            select,
            canManage
              ? h(
                  'button',
                  {
                    class: 'icon-button',
                    type: 'button',
                    title: 'Remove from workspace',
                    'aria-label': `Remove ${member.display_name}`,
                    onclick: () =>
                      apply(() => api.delete(`/api/workspaces/${workspace.id}/members/${member.user_id}`)),
                  },
                  icon('x', 15),
                )
              : null,
          );
        }),
      );
    }

    replace(
      detail,
      h('h3', null, workspace.name),
      h(
        'p',
        { class: 'settings-desc' },
        'Owners manage members and every page. Editors create and edit pages. Viewers can only read.',
      ),
      canManage
        ? memberPicker(
            (user) =>
              apply(() => api.put(`/api/workspaces/${workspace.id}/members/${user.id}`, { role: 'editor' })),
            () => new Set(current.map((member) => member.user_id)),
          )
        : null,
      table,
      canManage
        ? h(
            'div',
            { class: 'modal-actions', style: 'justify-content: flex-start' },
            h(
              'button',
              {
                class: 'button button-small',
                type: 'button',
                onclick: async () => {
                  const name = await promptDialog({ title: 'Rename workspace', value: workspace.name });
                  if (!name) return;
                  const updated = await guarded(() => api.patch(`/api/workspaces/${workspace.id}`, { name }));
                  if (updated) {
                    workspace.name = updated.name;
                    await refreshTree();
                    load();
                    openWorkspace(workspace);
                  }
                },
              },
              'Rename',
            ),
            h(
              'button',
              {
                class: 'button button-small button-danger',
                type: 'button',
                onclick: async () => {
                  const confirmed = await confirmDialog({
                    title: `Delete “${workspace.name}”?`,
                    message: 'All pages, versions and files in this workspace will be deleted permanently for every member. This cannot be undone.',
                    confirmLabel: 'Delete workspace',
                    danger: true,
                  });
                  if (!confirmed) return;
                  const ok = await guarded(() => api.delete(`/api/workspaces/${workspace.id}`));
                  if (ok) {
                    replace(detail);
                    await refreshTree();
                    load();
                  }
                },
              },
              'Delete workspace',
            ),
          )
        : null,
    );
    renderMembers();
  }

  replace(
    pane,
    h(
      'div',
      { class: 'settings-toolbar' },
      h('h3', null, 'Team workspaces'),
      isAdmin
        ? h(
            'button',
            {
              class: 'button button-small button-primary',
              type: 'button',
              onclick: async () => {
                const name = await promptDialog({
                  title: 'New team workspace',
                  label: 'Name',
                  placeholder: 'e.g. Engineering',
                  confirmLabel: 'Create',
                });
                if (!name) return;
                const created = await guarded(() => api.post('/api/workspaces', { name }));
                if (created) {
                  await refreshTree();
                  await load();
                  openWorkspace({ ...created, member_count: 1 });
                }
              },
            },
            icon('plus', 14),
            'New workspace',
          )
        : null,
    ),
    h(
      'p',
      { class: 'settings-desc' },
      'A team workspace is a shared space: every member can open its pages. Your Private section is only ever visible to you.',
    ),
    list,
    detail,
  );
  load();
}

// -- Admin: users ------------------------------------------------------------

function usersPane(pane) {
  const table = h('div');
  const invites = h('div');
  const registration = h('input', { type: 'checkbox' });

  async function load() {
    const [users, pending, settings] = await Promise.all([
      guarded(() => api.get('/api/admin/users')),
      guarded(() => api.get('/api/admin/invites')),
      guarded(() => api.get('/api/admin/settings')),
    ]);
    if (!users) return;
    registration.checked = Boolean(settings?.allow_registration);
    replace(
      table,
      h(
        'table',
        { class: 'table' },
        h('thead', null, h('tr', null, ['Name', 'Email', 'Role', 'Last sign-in', ''].map((t) => h('th', null, t)))),
        h(
          'tbody',
          null,
          users.map((user) =>
            h(
              'tr',
              null,
              h('td', null, h('div', { class: 'list-title' }, user.display_name), h('div', { class: 'list-sub' }, `@${user.username}`)),
              h('td', null, user.email),
              h(
                'td',
                null,
                user.is_active
                  ? h('span', { class: `badge${user.is_admin ? ' badge-accent' : ''}` }, user.is_admin ? 'Administrator' : 'Member')
                  : h('span', { class: 'badge' }, 'Deactivated'),
              ),
              h('td', { class: 'muted' }, user.last_login_at ? timeAgo(user.last_login_at) : 'Never'),
              h('td', { class: 'is-actions' }, userActions(user)),
            ),
          ),
        ),
      ),
    );
    replace(
      invites,
      pending?.length
        ? pending.map((invite) =>
            h(
              'div',
              { class: 'list-row' },
              icon('user-plus', 16),
              h(
                'div',
                { class: 'list-main' },
                h('div', { class: 'list-title' }, invite.email || 'Anyone with the link'),
                h('div', { class: 'list-sub' }, `Expires ${formatDate(invite.expires_at)}${invite.is_admin ? ' · administrator' : ''}`),
              ),
              h(
                'button',
                {
                  class: 'button button-small',
                  type: 'button',
                  onclick: async () => {
                    await guarded(() => api.delete(`/api/admin/invites/${invite.id}`));
                    load();
                  },
                },
                'Revoke',
              ),
            ),
          )
        : h('div', { class: 'muted' }, 'No pending invitations.'),
    );
  }

  function userActions(user) {
    const patch = async (changes) => {
      await guarded(() => api.patch(`/api/admin/users/${user.id}`, changes));
      load();
    };
    const resetPassword = async () => {
      const password = await promptDialog({
        title: `New password for ${user.display_name}`,
        label: 'At least 8 characters. They will be signed out everywhere.',
        type: 'password',
        confirmLabel: 'Set password',
      });
      if (!password) return;
      const ok = await guarded(() => api.post(`/api/admin/users/${user.id}/password`, { password }));
      if (ok) toast('Password updated', { type: 'success' });
    };
    const button = h(
      'button',
      {
        class: 'icon-button',
        type: 'button',
        title: 'Manage user',
        'aria-label': `Manage ${user.display_name}`,
        'aria-haspopup': 'menu',
      },
      icon('more', 16),
    );
    button.addEventListener('click', () => {
      openMenu({
        anchor: button,
        placement: 'bottom-end',
        items: [
          { label: 'Reset password…', icon: 'key', onSelect: resetPassword },
          {
            label: user.is_admin ? 'Remove administrator role' : 'Make administrator',
            icon: 'shield',
            onSelect: () => patch({ is_admin: !user.is_admin }),
          },
          { separator: true },
          user.is_active
            ? {
                label: 'Deactivate account',
                icon: 'lock',
                danger: true,
                onSelect: () => patch({ is_active: false }),
              }
            : { label: 'Reactivate account', icon: 'check', onSelect: () => patch({ is_active: true }) },
        ],
      });
    });
    return button;
  }

  function openCreateUser() {
    const name = field('Name', { maxLength: 120 });
    const username = field('Username', { required: true, autocapitalize: 'none', spellcheck: false });
    const email = field('Email', { type: 'email', required: true });
    const password = field('Initial password', { type: 'password', required: true, minLength: 8, autocomplete: 'new-password' });
    const admin = h('input', { type: 'checkbox' });
    const error = formError();
    const modal = openModal({
      title: 'Create user',
      className: 'modal-small',
      content: h(
        'form',
        {
          class: 'form',
          onsubmit: async (event) => {
            event.preventDefault();
            const created = await guarded(
              () =>
                api.post('/api/admin/users', {
                  display_name: name.input.value,
                  username: username.input.value,
                  email: email.input.value,
                  password: password.input.value,
                  is_admin: admin.checked,
                }),
              error,
            );
            if (created) {
              modal.close();
              toast(`Account for ${created.display_name} created`, { type: 'success' });
              load();
            }
          },
        },
        name.el,
        username.el,
        email.el,
        password.el,
        h('label', { class: 'checkbox' }, admin, 'Administrator'),
        error,
        h(
          'div',
          { class: 'modal-actions' },
          h('button', { class: 'button', type: 'button', onclick: () => modal.close() }, 'Cancel'),
          h('button', { class: 'button button-primary', type: 'submit' }, 'Create user'),
        ),
      ),
    });
  }

  async function createInvite() {
    const email = await promptDialog({
      title: 'Invite someone',
      label: 'Email address (optional — leave empty for a link anyone can use once)',
      type: 'email',
      confirmLabel: 'Create invitation link',
      required: false,
    });
    if (email === null) return;
    const invite = await guarded(() => api.post('/api/admin/invites', { email: email || null }));
    if (!invite) return;
    load();
    const link = `${location.origin}${invite.path}`;
    const input = h('input', { class: 'input', value: link, readOnly: true, 'aria-label': 'Invitation link' });
    openModal({
      title: 'Invitation link',
      content: [
        h('p', { class: 'settings-desc' }, 'Send this link to the person you are inviting. It works once and expires in 7 days. It is only shown now.'),
        h(
          'div',
          { class: 'copy-field' },
          input,
          h(
            'button',
            {
              class: 'button',
              type: 'button',
              onclick: async () => {
                input.select();
                try {
                  await navigator.clipboard.writeText(link);
                  toast('Link copied', { type: 'success', duration: 2000 });
                } catch {
                  // Selection is already made; the user can copy manually.
                }
              },
            },
            icon('copy', 14),
            'Copy',
          ),
        ),
      ],
    });
    input.select();
  }

  registration.addEventListener('change', async () => {
    await guarded(() => api.put('/api/admin/settings', { allow_registration: registration.checked }));
  });

  replace(
    pane,
    h(
      'div',
      { class: 'settings-toolbar' },
      h('h3', null, 'Users'),
      h('button', { class: 'button button-small', type: 'button', onclick: createInvite }, icon('link', 14), 'Invite by link'),
      h('button', { class: 'button button-small button-primary', type: 'button', onclick: openCreateUser }, icon('plus', 14), 'Create user'),
    ),
    table,
    h('h3', null, 'Pending invitations'),
    invites,
    h('h3', null, 'Registration'),
    h('label', { class: 'checkbox' }, registration, 'Allow anyone who can reach this server to create an account'),
    h('p', { class: 'field-hint', style: 'margin-top: 6px' }, 'Off by default. With it off, new people join through accounts or invitation links you create.'),
  );
  load();
}

// -- Admin: backups ----------------------------------------------------------

function backupsPane(pane) {
  const list = h('div');
  const create = h('button', { class: 'button button-small button-primary', type: 'button' }, icon('database', 14), 'Create backup');

  async function load() {
    const backups = await guarded(() => api.get('/api/admin/backups'));
    if (!backups) return;
    replace(
      list,
      backups.length
        ? backups.map((backup) =>
            h(
              'div',
              { class: 'list-row' },
              icon('archive', 16),
              h(
                'div',
                { class: 'list-main' },
                h('div', { class: 'list-title' }, backup.name),
                h('div', { class: 'list-sub' }, `${formatBytes(backup.size)} · ${formatDate(backup.created_at, true)}`),
              ),
              h(
                'a',
                { class: 'button button-small', href: `/api/admin/backups/${backup.name}`, download: backup.name },
                icon('download', 14),
                'Download',
              ),
              h(
                'button',
                {
                  class: 'icon-button',
                  type: 'button',
                  title: 'Delete backup',
                  'aria-label': `Delete ${backup.name}`,
                  onclick: async () => {
                    const confirmed = await confirmDialog({
                      title: 'Delete this backup?',
                      message: `${backup.name} will be removed from the server.`,
                      confirmLabel: 'Delete',
                      danger: true,
                    });
                    if (!confirmed) return;
                    await guarded(() => api.delete(`/api/admin/backups/${backup.name}`));
                    load();
                  },
                },
                icon('trash-2', 15),
              ),
            ),
          )
        : h('div', { class: 'empty' }, icon('archive', 26), h('div', { class: 'empty-title' }, 'No backups yet')),
    );
  }

  create.addEventListener('click', async () => {
    create.disabled = true;
    const backup = await guarded(() => api.post('/api/admin/backups'));
    create.disabled = false;
    if (backup) {
      toast('Backup created', { type: 'success' });
      load();
    }
  });

  replace(
    pane,
    h('div', { class: 'settings-toolbar' }, h('h3', null, 'Backups'), create),
    h(
      'p',
      { class: 'settings-desc' },
      'A backup contains a consistent copy of the database and every uploaded file. Backups are stored in data/backups on the server; download them to keep a copy elsewhere.',
    ),
    list,
    h('h3', null, 'Restoring'),
    h(
      'p',
      { class: 'settings-desc' },
      'Restoring replaces all current data, so it is done from the command line with the server stopped:',
    ),
    h('div', { class: 'copy-field' }, h('input', { class: 'input', readOnly: true, value: 'uv run python -m app restore <backup-file>' })),
  );
  load();
}

// -- Admin: audit log --------------------------------------------------------

function auditPane(pane) {
  const table = h('div');
  replace(
    pane,
    h('h3', null, 'Activity log'),
    h('p', { class: 'settings-desc' }, 'Security-relevant events: sign-ins, sharing, user and workspace changes, backups.'),
    table,
  );
  guarded(() => api.get('/api/admin/audit?limit=200')).then((events) => {
    if (!events) return;
    replace(
      table,
      h(
        'table',
        { class: 'table' },
        h('thead', null, h('tr', null, ['When', 'Who', 'Event', 'Details'].map((t) => h('th', null, t)))),
        h(
          'tbody',
          null,
          events.map((event) =>
            h(
              'tr',
              null,
              h('td', { class: 'muted', style: 'white-space: nowrap' }, formatDate(event.created_at, true)),
              h('td', null, event.user_name ?? '—'),
              h('td', null, event.action),
              h(
                'td',
                { class: 'muted' },
                [
                  event.target_type ? `${event.target_type} ${event.target_id}` : null,
                  event.detail ? JSON.stringify(event.detail) : null,
                ]
                  .filter(Boolean)
                  .join(' · '),
              ),
            ),
          ),
        ),
      ),
    );
  });
}

// -- Dialog ------------------------------------------------------------------

export function openSettings(initial = 'account') {
  const sections = [
    { id: 'account', label: 'My account', icon: 'user', render: accountPane },
    { id: 'appearance', label: 'Appearance', icon: 'sun', render: appearancePane },
    { id: 'workspaces', label: 'Workspaces', icon: 'building', render: workspacesPane },
  ];
  if (store.user.is_admin) {
    sections.push(
      { heading: 'Administration' },
      { id: 'users', label: 'Users', icon: 'users', render: usersPane },
      { id: 'backups', label: 'Backups', icon: 'database', render: backupsPane },
      { id: 'audit', label: 'Activity log', icon: 'shield', render: auditPane },
    );
  }
  const nav = h('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' });
  const pane = h('div', { class: 'settings-pane' });

  function show(id) {
    const section = sections.find((entry) => entry.id === id) ?? sections[0];
    replace(
      nav,
      sections.map((entry) =>
        entry.heading
          ? h('div', { class: 'menu-heading' }, entry.heading)
          : h(
              'button',
              {
                class: `menu-item${entry.id === section.id ? ' is-active' : ''}`,
                type: 'button',
                style: 'width: 100%',
                'aria-current': entry.id === section.id ? 'true' : null,
                onclick: () => show(entry.id),
              },
              icon(entry.icon, 16),
              h('span', { class: 'menu-label', style: 'text-align: left' }, entry.label),
            ),
      ),
    );
    replace(pane);
    pane.scrollTop = 0;
    section.render(pane);
  }

  openModal({ title: 'Settings', className: 'settings', content: [nav, pane] });
  show(initial);
}
