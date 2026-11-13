// Home: recent pages and quick ways to start writing.
import { h, kbd, replace } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { createPage } from './actions.js';
import { pagePath } from './router.js';
import { ancestorsOf, getPage, on, pageTitle, personalWorkspace, store } from './store.js';

function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return 'Good night';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function card(page) {
  const path = ancestorsOf(page.id).map(pageTitle).join(' / ');
  return h(
    'a',
    { class: 'page-card', href: pagePath(page.id), dataset: { link: '' } },
    h('span', { class: 'page-card-icon' }, page.icon || icon('file-text', 20)),
    h('span', { class: 'page-card-title' }, pageTitle(page)),
    path ? h('span', { class: 'page-card-sub' }, path) : null,
  );
}

export function mountHome({ container, topbar, shell }) {
  document.title = 'MindDock';
  replace(topbar, h('nav', { class: 'breadcrumbs' }, h('span', { class: 'crumb' }, 'Home')));

  function render() {
    const recents = store.recents.map(getPage).filter(Boolean).slice(0, 8);
    const favorites = store.favorites.map(getPage).filter(Boolean);
    const firstName = store.user.display_name.split(' ')[0];
    replace(
      container,
      h(
        'div',
        { class: 'home' },
        h('h1', { class: 'home-title' }, `${greeting()}, ${firstName}`),
        h('p', { class: 'home-sub' }, 'Pick up where you left off, or start something new.'),
        h(
          'div',
          { class: 'home-actions' },
          h(
            'button',
            {
              class: 'button button-primary',
              type: 'button',
              onclick: () => createPage({ workspaceId: personalWorkspace()?.id }),
            },
            icon('plus', 15),
            'New page',
          ),
          h(
            'button',
            { class: 'button', type: 'button', onclick: shell.openCapture },
            icon('zap', 15),
            'Quick capture',
          ),
          h(
            'button',
            { class: 'button', type: 'button', onclick: shell.openSearch },
            icon('search', 15),
            'Search',
            h('span', { class: 'kbd' }, kbd('Mod+K')),
          ),
        ),
        favorites.length
          ? [
              h('h2', { class: 'section-title' }, 'Favorites'),
              h('div', { class: 'card-grid', style: 'margin-bottom: 26px' }, favorites.map(card)),
            ]
          : null,
        h('h2', { class: 'section-title' }, 'Recently opened'),
        recents.length
          ? h('div', { class: 'card-grid' }, recents.map(card))
          : h(
              'div',
              { class: 'empty' },
              icon('note', 28),
              h('div', { class: 'empty-title' }, 'Your workspace is empty'),
              h('div', null, 'Create your first page to start writing.'),
            ),
      ),
    );
  }

  render();
  const unsubscribe = on('tree', render);
  return { flush: async () => {}, destroy: unsubscribe };
}
