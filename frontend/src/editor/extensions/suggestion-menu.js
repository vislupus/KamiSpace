// A keyboard-driven list shown at the caret, shared by the slash menu and the
// page-mention menu. It never takes the focus away from the editor.
import { h } from '../../lib/dom.js';
import { positionElement } from '../../lib/popover.js';

/**
 * @param {object} options
 * @param {string} options.className     extra class for the popover
 * @param {(item) => Node} options.renderItem  row contents
 * @param {string} options.emptyText
 * @param {(view) => void} options.onEscape
 */
export function createSuggestionRenderer({ className, renderItem, emptyText, onEscape }) {
  return () => {
    let el = null;
    let list = null;
    let items = [];
    let active = 0;
    let props = null;

    function select(index) {
      const item = items[index];
      if (item) props.command(item);
    }

    function highlight(index) {
      active = index;
      [...list.children].forEach((child, i) => child.classList.toggle('is-active', i === active));
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    }

    function render() {
      list.replaceChildren(
        ...(items.length
          ? items.map((item, index) => {
              const row = h(
                'div',
                {
                  class: `slash-item${index === active ? ' is-active' : ''}`,
                  role: 'option',
                  dataset: { command: item.id ?? '' },
                },
                renderItem(item),
              );
              // mousedown, not click: the editor must keep its selection.
              row.addEventListener('mousedown', (event) => {
                event.preventDefault();
                select(index);
              });
              row.addEventListener('mousemove', () => {
                if (active !== index) highlight(index);
              });
              return row;
            })
          : [h('div', { class: 'slash-empty' }, emptyText)]),
      );
    }

    function place() {
      if (el && props?.clientRect) positionElement(el, props.clientRect, 'bottom-start', 6);
    }

    return {
      onStart(next) {
        props = next;
        items = next.items;
        active = 0;
        list = h('div', { class: 'slash-list', role: 'listbox' });
        el = h('div', { class: `popover slash-menu ${className}`.trim() }, list);
        document.body.append(el);
        render();
        place();
      },
      onUpdate(next) {
        props = next;
        items = next.items;
        active = 0;
        render();
        place();
      },
      onKeyDown({ event, view }) {
        if (event.key === 'ArrowDown') {
          if (items.length) highlight((active + 1) % items.length);
          return true;
        }
        if (event.key === 'ArrowUp') {
          if (items.length) highlight((active - 1 + items.length) % items.length);
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          if (!items.length) return false;
          select(active);
          return true;
        }
        if (event.key === 'Escape') {
          onEscape(view);
          return true;
        }
        return false;
      },
      onExit() {
        el?.remove();
        el = null;
        list = null;
        props = null;
      },
    };
  };
}
