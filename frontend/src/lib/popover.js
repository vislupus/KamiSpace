// Floating layers (menus, pickers, toolbars) that always stay inside the viewport.
import { clamp } from './util.js';

const MARGIN = 8;
const stack = [];

function rectOf(anchor) {
  if (typeof anchor === 'function') return anchor();
  if (anchor instanceof Element) return anchor.getBoundingClientRect();
  if (anchor && typeof anchor.getBoundingClientRect === 'function') {
    return anchor.getBoundingClientRect();
  }
  // A plain point: { x, y }
  return new DOMRect(anchor.x, anchor.y, 0, 0);
}

/**
 * Place `el` (position: fixed) next to an anchor rectangle.
 * placement: "bottom-start" | "bottom-end" | "top-start" | "top-center" |
 *            "right-start" | "left-start" | "bottom-center"
 * Flips to the opposite side when there is not enough room and finally clamps
 * to the viewport so nothing can overflow.
 */
export function positionElement(el, anchor, placement = 'bottom-start', offset = 6) {
  const rect = rectOf(anchor);
  if (!rect) return;
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight;
  let [side, align = 'start'] = placement.split('-');

  const fitsBelow = rect.bottom + offset + height <= viewportHeight - MARGIN;
  const fitsAbove = rect.top - offset - height >= MARGIN;
  const fitsRight = rect.right + offset + width <= viewportWidth - MARGIN;
  const fitsLeft = rect.left - offset - width >= MARGIN;
  if (side === 'bottom' && !fitsBelow && fitsAbove) side = 'top';
  else if (side === 'top' && !fitsAbove && fitsBelow) side = 'bottom';
  else if (side === 'right' && !fitsRight && fitsLeft) side = 'left';
  else if (side === 'left' && !fitsLeft && fitsRight) side = 'right';

  let left;
  let top;
  if (side === 'bottom' || side === 'top') {
    top = side === 'bottom' ? rect.bottom + offset : rect.top - offset - height;
    if (align === 'start') left = rect.left;
    else if (align === 'end') left = rect.right - width;
    else left = rect.left + rect.width / 2 - width / 2;
  } else {
    left = side === 'right' ? rect.right + offset : rect.left - offset - width;
    top = align === 'end' ? rect.bottom - height : rect.top;
  }
  left = clamp(left, MARGIN, Math.max(MARGIN, viewportWidth - width - MARGIN));
  top = clamp(top, MARGIN, Math.max(MARGIN, viewportHeight - height - MARGIN));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.dataset.side = side;
}

/**
 * Open a dismissible popover. Closes on Escape, on outside press and when
 * `close()` is called. Returns { el, close, reposition }.
 */
export function openPopover({
  anchor,
  content,
  placement = 'bottom-start',
  offset = 6,
  className = '',
  onClose,
  restoreFocus = true,
  role = 'dialog',
  // Pressing the anchor while open normally closes the popover (toggle).
  // Sub-menus stay open instead: their anchor is the parent menu item.
  closeOnAnchorPress = true,
}) {
  const previousFocus = document.activeElement;
  const el = document.createElement('div');
  el.className = `popover ${className}`.trim();
  el.setAttribute('role', role);
  el.append(content);
  document.body.append(el);

  const controller = new AbortController();
  const { signal } = controller;
  let closed = false;

  const entry = { el, close };
  stack.push(entry);

  function reposition() {
    if (!closed) positionElement(el, anchor, placement, offset);
  }

  function close({ focus = restoreFocus } = {}) {
    if (closed) return;
    closed = true;
    // Close anything opened on top of this popover first (sub-menus).
    const index = stack.indexOf(entry);
    if (index !== -1) {
      for (const child of stack.splice(index).slice(1).reverse()) child.close({ focus: false });
    }
    controller.abort();
    el.remove();
    if (focus && previousFocus instanceof HTMLElement && previousFocus.isConnected) {
      previousFocus.focus({ preventScroll: true });
    }
    onClose?.();
  }

  document.addEventListener(
    'pointerdown',
    (event) => {
      const index = stack.indexOf(entry);
      const inSelfOrChild = stack.slice(index).some((item) => item.el.contains(event.target));
      if (inSelfOrChild) return;
      if (anchor instanceof Element && anchor.contains(event.target)) {
        if (!closeOnAnchorPress) return;
        // Pressing the anchor again closes the popover instead of reopening it:
        // swallow the click that follows this press.
        const swallow = (click) => {
          click.stopPropagation();
          click.preventDefault();
        };
        anchor.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => anchor.removeEventListener('click', swallow, { capture: true }), 400);
      }
      close({ focus: false });
    },
    { capture: true, signal },
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && stack[stack.length - 1] === entry) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    },
    { capture: true, signal },
  );
  window.addEventListener('resize', reposition, { signal });
  window.addEventListener('scroll', reposition, { capture: true, passive: true, signal });

  reposition();
  return { el, close, reposition };
}

export function closeAllPopovers() {
  while (stack.length) stack[0].close({ focus: false });
}

export function hasOpenPopover() {
  return stack.length > 0;
}
