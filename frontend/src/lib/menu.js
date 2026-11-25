// Keyboard-navigable menus built on popovers.
import { h } from './dom.js';
import { icon } from './icons.js';
import { openPopover } from './popover.js';

/**
 * items: Array of
 *   { label, icon?, emoji?, swatch?, description?, hint?, danger?, disabled?, checked?, onSelect?, submenu? }
 *   { separator: true } | { heading: 'Text' }
 */
export function openMenu({
  anchor,
  items,
  placement = 'bottom-start',
  className = '',
  onClose,
  isSubmenu = false,
}) {
  const list = h('div', { class: 'menu', tabIndex: -1 });
  const rows = [];
  let activeIndex = -1;
  let submenu = null;
  let popover = null;

  function closeSubmenu() {
    submenu?.close({ focus: false });
    submenu = null;
  }

  function setActive(index, { openSub = false } = {}) {
    if (index === activeIndex && !openSub) return;
    rows[activeIndex]?.el.classList.remove('is-active');
    activeIndex = index;
    const row = rows[index];
    if (!row) return;
    row.el.classList.add('is-active');
    row.el.scrollIntoView({ block: 'nearest' });
    closeSubmenu();
    if (row.item.submenu && openSub) openSubmenu(row);
  }

  function openSubmenu(row) {
    closeSubmenu();
    submenu = openMenu({
      anchor: row.el,
      items: row.item.submenu,
      placement: 'right-start',
      isSubmenu: true,
      onClose: () => {
        submenu = null;
      },
    });
    submenu.onPicked = () => popover.close();
    submenu.onBack = () => {
      closeSubmenu();
      list.focus();
    };
  }

  function choose(row) {
    if (row.item.disabled) return;
    if (row.item.submenu) {
      if (!submenu) openSubmenu(row);
      submenu.focusFirst();
      return;
    }
    const handle = api;
    popover.close();
    handle.onPicked?.();
    row.item.onSelect?.();
  }

  for (const item of items) {
    if (!item) continue;
    if (item.separator) {
      list.append(h('div', { class: 'menu-separator', role: 'separator' }));
      continue;
    }
    if (item.heading) {
      list.append(h('div', { class: 'menu-heading' }, item.heading));
      continue;
    }
    const el = h(
      'div',
      {
        class: `menu-item${item.danger ? ' is-danger' : ''}${item.disabled ? ' is-disabled' : ''}`,
        role: 'menuitem',
        'aria-disabled': item.disabled ? 'true' : null,
      },
      item.swatch
        ? h('span', { class: 'db-swatch', dataset: { color: item.swatch } })
        : item.emoji
          ? h('span', { class: 'menu-emoji' }, item.emoji)
          : item.icon
            ? icon(item.icon, 16)
            : null,
      h(
        'span',
        { class: 'menu-label' },
        item.label,
        item.description ? h('span', { class: 'menu-description' }, item.description) : null,
      ),
      item.hint ? h('span', { class: 'menu-hint' }, item.hint) : null,
      item.checked ? icon('check', 15) : null,
      item.submenu ? icon('chevron-right', 14) : null,
    );
    const row = { el, item };
    const index = rows.length;
    rows.push(row);
    el.addEventListener('pointerenter', () => setActive(index, { openSub: true }));
    el.addEventListener('click', () => choose(row));
    list.append(el);
  }

  function move(delta) {
    if (!rows.length) return;
    let index = activeIndex;
    for (let i = 0; i < rows.length; i += 1) {
      index = (index + delta + rows.length) % rows.length;
      if (!rows[index].item.disabled) break;
    }
    setActive(index);
  }

  list.addEventListener('keydown', (event) => {
    switch (event.key) {
      case 'ArrowDown':
        move(1);
        break;
      case 'ArrowUp':
        move(-1);
        break;
      case 'Home':
        setActive(0);
        break;
      case 'End':
        setActive(rows.length - 1);
        break;
      case 'Enter':
      case ' ':
        if (rows[activeIndex]) choose(rows[activeIndex]);
        break;
      case 'ArrowRight':
        if (rows[activeIndex]?.item.submenu) choose(rows[activeIndex]);
        break;
      case 'ArrowLeft':
        api.onBack?.();
        break;
      case 'Tab':
        popover.close();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  });

  popover = openPopover({
    anchor,
    content: list,
    placement,
    className: `menu-popover ${className}`.trim(),
    onClose,
    role: 'menu',
    closeOnAnchorPress: !isSubmenu,
  });
  const api = {
    close: popover.close,
    el: popover.el,
    onPicked: null,
    onBack: null,
    focusFirst() {
      list.focus({ preventScroll: true });
      setActive(rows.findIndex((row) => !row.item.disabled));
    },
  };
  list.focus({ preventScroll: true });
  return api;
}
