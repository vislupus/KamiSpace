// To-do items that can be assigned to a person and given a due date.
// Each item carries a stable id, so the server can list "My tasks" and tick
// an item from outside the editor.
import { TaskItem } from '@tiptap/extension-list';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { openMenu } from '../../lib/menu.js';
import { openPopover } from '../../lib/popover.js';
import { appContext } from './app-context.js';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function newTaskId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('');
}

function todayIso() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function formatDue(due) {
  const [year, month, day] = due.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const sameYear = year === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
}

function plainAttribute(name, dataName, parse = (value) => value) {
  return {
    [name]: {
      default: null,
      keepOnSplit: false, // a new item starts unassigned, with its own id
      parseHTML: (element) => {
        const value = element.getAttribute(dataName);
        return value ? parse(value) : null;
      },
      renderHTML: (attributes) => (attributes[name] ? { [dataName]: attributes[name] } : {}),
    },
  };
}

export const AssignableTaskItem = TaskItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...plainAttribute('taskId', 'data-task-id'),
      ...plainAttribute('assignee', 'data-assignee', Number),
      ...plainAttribute('due', 'data-due'),
    };
  },

  addNodeView() {
    const createView = this.parent?.();
    return (props) => {
      const { editor, getPos } = props;
      const context = appContext(editor);
      const view = createView(props);
      let current = props.node;
      const meta = h('span', { class: 'task-meta', contentEditable: 'false' });
      view.dom.append(meta);

      const setAttributes = (changes) => {
        if (!editor.isEditable || typeof getPos !== 'function') return;
        const pos = getPos();
        const node = editor.state.doc.nodeAt(pos);
        if (!node) return;
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...changes }),
        );
      };

      const pickAssignee = (anchor) => {
        const users = context.listUsers();
        openMenu({
          anchor,
          placement: 'bottom-end',
          items: [
            { heading: 'Assign to' },
            ...users.map((user) => ({
              label: user.username,
              icon: 'user',
              checked: user.id === current.attrs.assignee,
              onSelect: () => setAttributes({ assignee: user.id }),
            })),
            current.attrs.assignee ? { separator: true } : null,
            current.attrs.assignee
              ? { label: 'Unassign', icon: 'x', onSelect: () => setAttributes({ assignee: null }) }
              : null,
          ],
        });
      };

      const pickDue = (anchor) => {
        const input = h('input', {
          class: 'input',
          type: 'date',
          value: current.attrs.due ?? '',
          'aria-label': 'Due date',
        });
        const apply = (value) => {
          popover.close();
          setAttributes({ due: value || null });
        };
        input.addEventListener('change', () => apply(input.value));
        const popover = openPopover({
          anchor,
          placement: 'bottom-end',
          className: 'due-popover',
          content: h(
            'div',
            { class: 'due-editor' },
            input,
            h(
              'div',
              { class: 'due-shortcuts' },
              h('button', { class: 'button button-small', type: 'button', onclick: () => apply(todayIso()) }, 'Today'),
              current.attrs.due
                ? h('button', { class: 'button button-small', type: 'button', onclick: () => apply(null) }, 'Clear')
                : null,
            ),
          ),
        });
        input.focus();
      };

      const render = () => {
        const { assignee, due, checked } = current.attrs;
        const editable = editor.isEditable;
        const name = assignee ? context.userName(assignee) : null;
        const parts = [];

        if (due) {
          const overdue = !checked && due < todayIso();
          const chip = h(
            editable ? 'button' : 'span',
            {
              class: `task-chip task-due${overdue ? ' is-overdue' : ''}`,
              type: editable ? 'button' : null,
              title: overdue ? 'Overdue' : 'Due date',
            },
            icon('calendar', 12),
            formatDue(due),
          );
          if (editable) chip.addEventListener('click', () => pickDue(chip));
          parts.push(chip);
        } else if (editable) {
          const button = h(
            'button',
            { class: 'task-action', type: 'button', title: 'Set a due date', 'aria-label': 'Set a due date' },
            icon('calendar', 14),
          );
          button.addEventListener('click', () => pickDue(button));
          parts.push(button);
        }

        if (assignee) {
          const chip = h(
            editable ? 'button' : 'span',
            {
              class: 'task-chip task-assignee',
              type: editable ? 'button' : null,
              title: 'Assigned to',
            },
            icon('user', 12),
            name ?? 'Former member',
          );
          if (editable) chip.addEventListener('click', () => pickAssignee(chip));
          parts.push(chip);
        } else if (editable) {
          const button = h(
            'button',
            { class: 'task-action', type: 'button', title: 'Assign to someone', 'aria-label': 'Assign to someone' },
            icon('user-plus', 14),
          );
          button.addEventListener('click', () => pickAssignee(button));
          parts.push(button);
        }
        meta.replaceChildren(...parts);
      };
      render();
      meta.addEventListener('mousedown', (event) => event.preventDefault());

      const update = view.update;
      return {
        ...view,
        update(node, ...rest) {
          const handled = update(node, ...rest);
          if (handled) {
            const changed =
              node.attrs.assignee !== current.attrs.assignee ||
              node.attrs.due !== current.attrs.due ||
              node.attrs.checked !== current.attrs.checked;
            current = node;
            if (changed) render();
          }
          return handled;
        },
        stopEvent: (event) => meta.contains(event.target),
        ignoreMutation: (mutation) => mutation.type !== 'selection' && meta.contains(mutation.target),
      };
    };
  },

  addProseMirrorPlugins() {
    const type = this.type;
    return [
      ...(this.parent?.() ?? []),
      // Give every to-do item its own id (new items, pasted copies, splits).
      new Plugin({
        key: new PluginKey('taskIds'),
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          const seen = new Set();
          let tr = null;
          newState.doc.descendants((node, pos) => {
            if (node.type !== type) return !node.isTextblock;
            const id = node.attrs.taskId;
            if (!id || seen.has(id)) {
              tr ??= newState.tr;
              const fresh = newTaskId();
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, taskId: fresh });
              seen.add(fresh);
            } else {
              seen.add(id);
            }
            return true;
          });
          return tr;
        },
      }),
    ];
  },
}).configure({ nested: true });
