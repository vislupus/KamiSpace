// The path at the top of a page is also a way sideways: pointing at one of
// its pages lists the pages next to it — those in the same parent — so that
// another one is a click away, as in Notion.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openPopover } from '../lib/popover.js';
import { pagePath } from './router.js';
import { childrenOf, getPage, rootPages, sharedRoots, store } from './store.js';

const OPEN_AFTER = 320; // ms of resting on a crumb before its list opens
const CLOSE_AFTER = 220; // ms to travel from the crumb to the list
const SHOWN = 7;

/** The pages in the same place as a page (itself included), in sidebar order. */
export function siblingsOf(pageId) {
  const page = getPage(pageId);
  if (!page) return [];
  if (page.is_row) {
    // Rows of a database: the other rows, in the order of the table.
    return [...store.pages.values()]
      .filter((item) => item.parent_id === page.parent_id && item.is_row)
      .sort((a, b) => a.position - b.position || a.id - b.id);
  }
  if (page.parent_id !== null) return childrenOf(page.parent_id);
  return page.shared ? sharedRoots() : rootPages(page.workspace_id);
}

let open = null; // { crumb, popover }
let timer = 0;

export function closeCrumbMenu() {
  clearTimeout(timer);
  if (!open) return;
  const { crumb, popover } = open;
  open = null;
  crumb.classList.remove('is-open');
  popover.close({ focus: false });
}

function show(crumb, pageId, currentId) {
  closeCrumbMenu();
  const pages = siblingsOf(pageId);
  // Nothing beside it: nothing to list.
  if (pages.length < 2) return;
  const list = h('div', { class: 'menu crumb-menu', role: 'menu' });
  const draw = (all) => {
    let shown = pages;
    if (!all && pages.length > SHOWN + 1) {
      // The part of the list around the page itself.
      const at = Math.max(pages.findIndex((page) => page.id === pageId), 0);
      const start = Math.min(Math.max(at - Math.floor(SHOWN / 2), 0), pages.length - SHOWN);
      shown = pages.slice(start, start + SHOWN);
    }
    const more = pages.length - shown.length;
    list.replaceChildren(
      ...shown.map((page) =>
        h(
          'a',
          {
            class: 'menu-item',
            role: 'menuitem',
            href: pagePath(page.id),
            dataset: { link: '' },
            'aria-current': page.id === currentId ? 'page' : null,
            // Ctrl+click and the middle button open a new tab; a plain click
            // is handled by the router, and the list has done its job.
            onclick: (event) => {
              if (!event.ctrlKey && !event.metaKey && !event.shiftKey) closeCrumbMenu();
            },
          },
          page.icon ? h('span', { class: 'menu-emoji' }, page.icon) : icon(page.kind === 'database' ? 'database' : 'file-text', 16),
          h('span', { class: 'menu-label' }, page.title || 'Untitled'),
        ),
      ),
      ...(more
        ? [
            h(
              'button',
              {
                class: 'crumb-more',
                type: 'button',
                onclick: () => {
                  draw(true);
                  popover.reposition();
                },
              },
              `${more} more`,
            ),
          ]
        : []),
    );
  };
  const popover = openPopover({
    anchor: crumb,
    placement: 'bottom-start',
    offset: 4,
    className: 'menu-popover',
    content: list,
    restoreFocus: false,
    closeOnAnchorPress: false,
    onClose: () => {
      if (open?.popover === popover) {
        open = null;
        crumb.classList.remove('is-open');
      }
    },
  });
  draw(false);
  popover.reposition();
  crumb.classList.add('is-open');
  open = { crumb, popover };
  popover.el.addEventListener('pointerenter', () => clearTimeout(timer));
  popover.el.addEventListener('pointerleave', () => {
    clearTimeout(timer);
    timer = setTimeout(closeCrumbMenu, CLOSE_AFTER);
  });
}

/**
 * Give a crumb its list of neighbouring pages: it opens when the pointer
 * rests on the crumb (or the crumb is focused and ↓ is pressed).
 * @param {HTMLElement} crumb
 * @param {number} pageId      the page the crumb stands for
 * @param {number} currentId   the page that is open
 */
export function attachCrumbMenu(crumb, pageId, currentId) {
  // Whether there is anything beside it is looked up when the list opens:
  // pages come and go while the path stays on screen.
  crumb.dataset.siblings = '';
  crumb.addEventListener('pointerenter', (event) => {
    if (event.pointerType === 'touch') return;
    clearTimeout(timer);
    if (open?.crumb === crumb) return;
    timer = setTimeout(() => crumb.isConnected && show(crumb, pageId, currentId), open ? 80 : OPEN_AFTER);
  });
  crumb.addEventListener('pointerleave', () => {
    clearTimeout(timer);
    timer = setTimeout(closeCrumbMenu, CLOSE_AFTER);
  });
  crumb.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    show(crumb, pageId, currentId);
    open?.popover.el.querySelector('a')?.focus();
  });
  // The crumb of the open page is not a link: a click opens its list at once.
  if (crumb.tagName !== 'A') {
    crumb.tabIndex = 0;
    crumb.addEventListener('click', () => {
      if (open?.crumb === crumb) closeCrumbMenu();
      else show(crumb, pageId, currentId);
    });
  }
}
