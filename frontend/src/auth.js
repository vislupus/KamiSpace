// Sign-in and registration pages (served without the main application bundle).
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/auth.css';
import { ApiError, request } from './lib/api.js';
import { h } from './lib/dom.js';

const root = document.getElementById('auth');
const mode = root.dataset.mode;
const params = new URLSearchParams(location.search);

/** Only same-site paths are accepted as a post-login destination. */
function nextPath() {
  const next = params.get('next') || '/';
  return /^\/(?!\/)/.test(next) && !next.includes('\\') ? next : '/';
}

function field(label, attributes) {
  const input = h('input', { class: 'input', required: true, ...attributes });
  return { input, el: h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input) };
}

function shell(title, subtitle, form, footer) {
  root.replaceChildren(
    h('div', { class: 'auth-brand' }, h('span', { class: 'logo-mark' }, 'M'), 'MindDock'),
    h(
      'div',
      { class: 'auth-card' },
      h('h1', { class: 'auth-title' }, title),
      h('p', { class: 'auth-sub' }, subtitle),
      form,
    ),
    footer ? h('p', { class: 'auth-foot' }, footer) : null,
    h('p', { class: 'auth-tagline' }, 'Your data. Your server. Your workspace.'),
  );
}

async function submit(form, error, button, url, payload) {
  error.textContent = '';
  button.disabled = true;
  try {
    await request('POST', url, payload, { noAuthRedirect: true });
    location.assign(nextPath());
  } catch (cause) {
    error.textContent =
      cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.';
    button.disabled = false;
  }
}

function renderLogin(registrationOpen) {
  const identifier = field('Username or email', {
    name: 'identifier',
    autocomplete: 'username',
    autocapitalize: 'none',
    spellcheck: false,
    autofocus: true,
  });
  const password = field('Password', {
    name: 'password',
    type: 'password',
    autocomplete: 'current-password',
  });
  const error = h('div', { class: 'form-error', role: 'alert' });
  const button = h('button', { class: 'button button-primary', type: 'submit' }, 'Sign in');
  const form = h(
    'form',
    {
      class: 'form',
      onsubmit: (event) => {
        event.preventDefault();
        submit(form, error, button, '/api/auth/login', {
          identifier: identifier.input.value,
          password: password.input.value,
        });
      },
    },
    identifier.el,
    password.el,
    error,
    button,
  );
  shell(
    'Sign in',
    'Welcome back to your workspace.',
    form,
    registrationOpen ? ['No account yet? ', h('a', { href: '/register' }, 'Create one')] : null,
  );
  identifier.input.focus();
}

function renderRegister(status) {
  const invite = params.get('invite');
  if (!status.open && !status.invite_valid) {
    shell(
      invite ? 'Invitation expired' : 'Registration is closed',
      invite
        ? 'This invitation link is no longer valid. Ask an administrator for a new one.'
        : 'New accounts are created by an administrator. Ask them for an invitation link.',
      h('a', { class: 'button', href: '/login' }, 'Back to sign in'),
    );
    return;
  }
  const name = field('Name', { name: 'name', autocomplete: 'name', required: false, autofocus: true });
  const username = field('Username', {
    name: 'username',
    autocomplete: 'username',
    autocapitalize: 'none',
    spellcheck: false,
    pattern: '[A-Za-z0-9._\\-]{2,64}',
  });
  const email = field('Email', {
    name: 'email',
    type: 'email',
    autocomplete: 'email',
    value: status.invite_email ?? '',
    readOnly: Boolean(status.invite_email),
  });
  const password = field('Password', {
    name: 'password',
    type: 'password',
    autocomplete: 'new-password',
    minLength: 8,
  });
  const error = h('div', { class: 'form-error', role: 'alert' });
  const button = h('button', { class: 'button button-primary', type: 'submit' }, 'Create account');
  const form = h(
    'form',
    {
      class: 'form',
      onsubmit: (event) => {
        event.preventDefault();
        submit(form, error, button, '/api/auth/register', {
          display_name: name.input.value,
          username: username.input.value,
          email: email.input.value,
          password: password.input.value,
          invite: invite || null,
        });
      },
    },
    name.el,
    username.el,
    email.el,
    password.el,
    h('span', { class: 'field-hint' }, 'At least 8 characters.'),
    error,
    button,
  );
  shell('Create your account', 'Join your team’s workspace.', form, [
    'Already have an account? ',
    h('a', { href: '/login' }, 'Sign in'),
  ]);
}

async function start() {
  let status = { open: false, invite_valid: false, invite_email: null };
  try {
    const invite = params.get('invite');
    const query = invite ? `?invite=${encodeURIComponent(invite)}` : '';
    status = await request('GET', `/api/auth/registration${query}`, undefined, {
      noAuthRedirect: true,
    });
  } catch {
    // The sign-in form still works without this information.
  }
  if (mode === 'register') renderRegister(status);
  else renderLogin(status.open);
}

start();
