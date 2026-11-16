// Sign-in and registration pages (served without the main application bundle).
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/auth.css';
import { ApiError, request } from './lib/api.js';
import { h } from './lib/dom.js';
import { logoMark } from './lib/logo.js';

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
  const parts = [
    h('div', { class: 'auth-brand' }, logoMark(28), 'KamiSpace'),
    h(
      'div',
      { class: 'auth-card' },
      h('h1', { class: 'auth-title' }, title),
      h('p', { class: 'auth-sub' }, subtitle),
      form,
    ),
    footer ? h('p', { class: 'auth-foot' }, footer) : null,
    h('p', { class: 'auth-tagline' }, 'Your data. Your server. Your workspace.'),
  ];
  // replaceChildren() would print a null argument as the text "null".
  root.replaceChildren(...parts.filter(Boolean));
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
  const username = field('Username', {
    name: 'username',
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
          username: username.input.value,
          password: password.input.value,
        });
      },
    },
    username.el,
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
  username.input.focus();
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
  const username = field('Username', {
    name: 'username',
    autocomplete: 'username',
    autocapitalize: 'none',
    spellcheck: false,
    pattern: '[A-Za-z0-9._\\-]{2,64}',
    autofocus: true,
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
          username: username.input.value,
          password: password.input.value,
          invite: invite || null,
        });
      },
    },
    username.el,
    h('span', { class: 'field-hint' }, 'Letters, digits, dots, dashes and underscores.'),
    password.el,
    h('span', { class: 'field-hint' }, 'At least 8 characters.'),
    error,
    button,
  );
  shell('Create your account', 'Choose a username and a password.', form, [
    'Already have an account? ',
    h('a', { href: '/login' }, 'Sign in'),
  ]);
  username.input.focus();
}

async function start() {
  let status = { open: false, invite_valid: false };
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
