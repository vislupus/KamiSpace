// Minimal DOM helpers. No virtual DOM: views build nodes once and update the
// few parts that change.

/**
 * h('div', { class: 'x', onclick: fn, dataset: { id: 1 } }, child, 'text')
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in el && key !== 'list' && key !== 'form') {
        el[key] = value;
      } else {
        el.setAttribute(key, value === true ? '' : value);
      }
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

export function replace(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

/** Listen with automatic cleanup through an AbortSignal. */
export function listen(target, type, handler, signal, options = {}) {
  target.addEventListener(type, handler, { ...options, signal });
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/** True when the platform "command" modifier is held (Ctrl, or ⌘ on macOS). */
export function modKey(event) {
  return isMac ? event.metaKey : event.ctrlKey;
}

/** Human readable shortcut: kbd('Mod+K') → "Ctrl K" / "⌘K". */
export function kbd(combo) {
  const parts = combo.split('+').map((part) => {
    if (part === 'Mod') return isMac ? '⌘' : 'Ctrl';
    if (part === 'Shift') return isMac ? '⇧' : 'Shift';
    if (part === 'Alt') return isMac ? '⌥' : 'Alt';
    return part;
  });
  return parts.join(isMac ? '' : '+');
}
