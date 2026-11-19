// My tasks: to-do items assigned to you, from every page you can open.
import { api } from '../lib/api.js';
import { h, replace } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toastError } from '../lib/toast.js';
import { pagePath } from './router.js';
import { emit, setOpenTasks } from './store.js';

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function formatDue(due) {
  const [year, month, day] = due.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: year === new Date().getFullYear() ? undefined : 'numeric',
  });
}

export function mountTasks({ container, topbar }) {
  document.title = 'My tasks · KamiSpace';
  replace(topbar, h('nav', { class: 'breadcrumbs' }, h('span', { class: 'crumb' }, 'My tasks')));
  let destroyed = false;
  let showDone = false;
  const list = h('div');
  const doneToggle = h('input', { type: 'checkbox' });

  async function load() {
    let tasks;
    try {
      tasks = await api.get(`/api/tasks?done=${showDone}`);
    } catch (error) {
      toastError(error);
      return;
    }
    if (destroyed) return;
    setOpenTasks(tasks.filter((task) => !task.checked).length);
    if (!tasks.length) {
      replace(
        list,
        h(
          'div',
          { class: 'empty' },
          icon('tasks', 28),
          h('div', { class: 'empty-title' }, 'Nothing assigned to you'),
          h('div', null, 'Tasks appear here when someone assigns a to-do item to you.'),
        ),
      );
      return;
    }
    const today = todayIso();
    replace(
      list,
      tasks.map((task) => {
        const box = h('input', {
          type: 'checkbox',
          checked: task.checked,
          disabled: !task.can_toggle,
          title: task.can_toggle ? '' : 'The page is locked',
          'aria-label': task.text || 'Task',
        });
        box.addEventListener('change', async () => {
          box.disabled = true;
          try {
            const result = await api.put(`/api/pages/${task.page_id}/tasks/${task.task_key}`, {
              checked: box.checked,
            });
            setOpenTasks(result.open_tasks);
            emit('page-content-changed', { pageId: task.page_id });
            load();
          } catch (error) {
            box.checked = !box.checked;
            box.disabled = false;
            toastError(error, 'Could not update the task');
          }
        });
        const overdue = task.due && !task.checked && task.due < today;
        return h(
          'div',
          { class: `list-row task-row${task.checked ? ' is-done' : ''}` },
          box,
          h(
            'div',
            { class: 'list-main' },
            h('div', { class: 'list-title' }, task.text || 'Untitled task'),
            task.can_open
              ? h(
                  'a',
                  { class: 'list-sub task-page', href: pagePath(task.page_id), dataset: { link: '' } },
                  task.page_icon ? `${task.page_icon} ` : '',
                  task.page_title || 'Untitled',
                )
              : h(
                  'span',
                  { class: 'list-sub task-page', title: 'Ask for the page to be shared with you to read more' },
                  'On a page that is not shared with you',
                ),
          ),
          task.due
            ? h(
                'span',
                { class: `task-chip task-due${overdue ? ' is-overdue' : ''}` },
                icon('calendar', 12),
                formatDue(task.due),
              )
            : null,
        );
      }),
    );
  }

  doneToggle.addEventListener('change', () => {
    showDone = doneToggle.checked;
    load();
  });

  replace(
    container,
    h(
      'div',
      { class: 'listing' },
      h(
        'div',
        { class: 'listing-head' },
        h('h1', null, 'My tasks'),
        h('label', { class: 'checkbox' }, doneToggle, 'Show completed'),
      ),
      h(
        'div',
        { class: 'share-note', style: 'margin: 0 0 14px' },
        icon('user-plus', 15),
        h(
          'span',
          null,
          'To give someone a task: add a to-do item on any page (type ',
          h('span', { class: 'kbd' }, '[]'),
          ' or ',
          h('span', { class: 'kbd' }, '/todo'),
          ') and type ',
          h('span', { class: 'kbd' }, '@name'),
          ' in it, or use the person button on its right. The next items you add with Enter go to the same person; select several items to assign them together, or pick “Assign all in this list”. The person sees the task here and can tick it off, even if the page itself is not shared with them.',
        ),
      ),
      list,
    ),
  );
  load();
  return {
    flush: async () => {},
    destroy() {
      destroyed = true;
    },
  };
}
