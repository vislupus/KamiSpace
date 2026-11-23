// To-do items that can be assigned to a person and given a due date.
// Each item carries a stable id, so the server can list "My tasks" and tick
// an item from outside the editor.
import { TaskItem } from '@tiptap/extension-list';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { formatDate, now } from '../../lib/bgcalendar.js';
import { createMonthPicker, dateInput } from '../../lib/datepicker.js';
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { openMenu } from '../../lib/menu.js';
import { openPopover } from '../../lib/popover.js';
import { toast } from '../../lib/toast.js';
import { appContext } from './app-context.js';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function newTaskId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('');
}

const todayIso = () => now().date;

/** "23.11.2026" */
export const formatDue = formatDate;

function plainAttribute(name, dataName, { parse = (value) => value, keepOnSplit = false } = {}) {
  return {
    [name]: {
      default: null,
      keepOnSplit,
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
      // Every item has its own id. Pressing Enter carries the person and the
      // due date over to the next item, so a run of tasks for one person is
      // assigned once.
      ...plainAttribute('taskId', 'data-task-id'),
      ...plainAttribute('assignee', 'data-assignee', { parse: Number, keepOnSplit: true }),
      ...plainAttribute('due', 'data-due', { keepOnSplit: true }),
    };
  },

  addNodeView() {
    const createView = this.parent?.();
    const type = this.type;
    // On a page that cannot be edited, a person may still tick the tasks
    // that are assigned to them (see the node view below).
    this.options.onReadOnlyChecked = (node) => {
      const me = appContext(this.editor).currentUserId;
      return Boolean(me && node.attrs.taskId && node.attrs.assignee === me);
    };
    return (props) => {
      const { editor, getPos } = props;
      const context = appContext(editor);
      const view = createView(props);
      let current = props.node;
      const meta = h('span', { class: 'task-meta', contentEditable: 'false' });
      view.dom.append(meta);

      if (!editor.isEditable) {
        const box = view.dom.querySelector('input[type="checkbox"]');
        const mine = Boolean(
          context.currentUserId &&
            current.attrs.taskId &&
            current.attrs.assignee === context.currentUserId,
        );
        if (box && !mine) box.disabled = true;
        if (box && mine) {
          box.title = 'Assigned to you';
          box.addEventListener('change', async () => {
            const checked = box.checked;
            view.dom.dataset.checked = String(checked);
            try {
              await context.toggleTask(current.attrs.taskId, checked);
            } catch (error) {
              box.checked = !checked;
              view.dom.dataset.checked = String(!checked);
              toast(error?.message || 'Could not update the task', { type: 'error' });
            }
          });
        }
      }

      /** Positions of the to-do items a change applies to. */
      const targets = (scope) => {
        const { state } = editor;
        const pos = getPos();
        if (scope === 'list') {
          const $pos = state.doc.resolve(pos);
          const list = $pos.parent;
          const positions = [];
          let offset = $pos.start();
          list.forEach((child) => {
            if (child.type === type) positions.push(offset);
            offset += child.nodeSize;
          });
          return positions;
        }
        // Several items selected: the change goes to all of them.
        const { from, to, empty } = state.selection;
        const selected = [];
        if (!empty) {
          state.doc.nodesBetween(from, to, (node, nodePos) => {
            if (node.type === type) selected.push(nodePos);
            return true;
          });
        }
        return selected.length > 1 && selected.includes(pos) ? selected : [pos];
      };

      const setAttributes = (changes, scope = 'selection') => {
        if (!editor.isEditable || typeof getPos !== 'function') return;
        const tr = editor.state.tr;
        for (const pos of targets(scope)) {
          const node = tr.doc.nodeAt(pos);
          if (node?.type === type) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...changes });
        }
        if (tr.docChanged) editor.view.dispatch(tr);
      };

      const pickAssignee = (anchor) => {
        const users = context.listUsers();
        const selected = targets('selection').length;
        const inList = targets('list').length;
        openMenu({
          anchor,
          placement: 'bottom-end',
          items: [
            { heading: selected > 1 ? `Assign ${selected} selected tasks to` : 'Assign to' },
            ...users.map((user) => ({
              label: user.username,
              icon: 'user',
              checked: selected === 1 && user.id === current.attrs.assignee,
              onSelect: () => setAttributes({ assignee: user.id }),
            })),
            { separator: true },
            inList > 1 && selected === 1
              ? {
                  label: `Assign all ${inList} in this list`,
                  icon: 'list-todo',
                  submenu: users.map((user) => ({
                    label: user.username,
                    icon: 'user',
                    onSelect: () => setAttributes({ assignee: user.id }, 'list'),
                  })),
                }
              : null,
            current.attrs.assignee || selected > 1
              ? { label: 'Unassign', icon: 'x', onSelect: () => setAttributes({ assignee: null }) }
              : null,
          ],
        });
      };

      const pickDue = (anchor) => {
        const apply = (value) => {
          popover.close();
          setAttributes({ due: value || null });
        };
        const field = dateInput({ value: current.attrs.due, label: 'Due date', onChange: apply });
        const picker = createMonthPicker({ selected: current.attrs.due, onPick: apply });
        const popover = openPopover({
          anchor,
          placement: 'bottom-end',
          className: 'due-popover',
          content: h(
            'div',
            { class: 'due-editor' },
            field.el,
            picker.el,
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
        field.el.focus();
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
