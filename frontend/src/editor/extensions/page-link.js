// Links between pages: a block that points to a page (this is how sub-pages
// appear in their parent) and an inline mention typed with "@" or "[[".
// Titles and icons are looked up live, so renaming a page updates every link.
import {
  Extension,
  Node,
  createAtomBlockMarkdownSpec,
  createInlineMarkdownSpec,
  mergeAttributes,
} from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Suggestion, exitSuggestion } from '@tiptap/suggestion';
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { insertBlockNode } from '../url-prompt.js';
import { appContext } from './app-context.js';
import { createSuggestionRenderer } from './suggestion-menu.js';

const PAGE_URL = /^\/p\/(\d+)\/?$/;

function linkView({ tag, className }) {
  return ({ node, editor }) => {
    const context = appContext(editor);
    const pageId = node.attrs.pageId;
    const dom = document.createElement(tag);
    dom.className = className;
    dom.contentEditable = 'false';
    dom.setAttribute('role', 'link');
    dom.tabIndex = -1;

    const render = () => {
      const page = context.getPage(pageId);
      dom.classList.toggle('is-missing', !page);
      dom.replaceChildren(
        h('span', { class: 'page-link-icon' }, page?.icon || icon('file-text', 15)),
        h('span', { class: 'page-link-title' }, page ? page.title || 'Untitled' : 'Page not available'),
      );
    };
    render();
    const unsubscribe = context.subscribe(render);
    dom.addEventListener('click', (event) => {
      if (!context.getPage(pageId)) return;
      event.preventDefault();
      context.openPage(pageId);
    });

    return {
      dom,
      update: (updated) => updated.type === node.type && updated.attrs.pageId === pageId,
      ignoreMutation: () => true,
      destroy: unsubscribe,
    };
  };
}

export const PageLink = Node.create({
  name: 'pageLink',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return { pageId: { default: null } };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-page-link]',
        getAttrs: (element) => ({ pageId: Number(element.getAttribute('data-page-id')) || null }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-page-link': '', 'data-page-id': node.attrs.pageId }),
    ];
  },
  ...createAtomBlockMarkdownSpec({
    nodeName: 'pageLink',
    requiredAttributes: ['pageId'],
    allowedAttributes: ['pageId'],
    parseAttributes: (text) => ({ pageId: Number(/pageId="?(\d+)/.exec(text)?.[1]) || null }),
  }),
  addNodeView() {
    return linkView({ tag: 'div', className: 'page-link' });
  },
});

export const PageMention = Node.create({
  name: 'pageMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { pageId: { default: null } };
  },
  parseHTML() {
    return [
      {
        tag: 'span[data-page-mention]',
        getAttrs: (element) => ({ pageId: Number(element.getAttribute('data-page-id')) || null }),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-page-mention': '',
        'data-page-id': node.attrs.pageId,
      }),
    ];
  },
  ...createInlineMarkdownSpec({
    nodeName: 'pageMention',
    name: 'page',
    selfClosing: true,
    allowedAttributes: ['pageId'],
    parseAttributes: (text) => ({ pageId: Number(/pageId="?(\d+)/.exec(text)?.[1]) || null }),
  }),
  addNodeView() {
    return linkView({ tag: 'span', className: 'page-mention' });
  },
});

/** Create a page inside the current one, link it at the caret and open it. */
export async function insertSubPage(editor, title = '') {
  const context = appContext(editor);
  const page = await context.createSubPage(title);
  if (!page || editor.isDestroyed) return;
  insertBlockNode(editor, editor.schema.nodes.pageLink.create({ pageId: page.id }));
  context.openPage(page.id);
}

/** Position of the to-do item the caret is in, or null. */
function enclosingTask(state) {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === 'taskItem') return $from.before(depth);
  }
  return null;
}

function mentionItems(editor, query, { canCreate, people = false }) {
  const context = appContext(editor);
  const needle = query.trim().toLowerCase();
  // Inside a to-do item "@" first offers people: picking one assigns the task.
  const assignees =
    people && enclosingTask(editor.state) !== null
      ? context
          .listUsers()
          .filter((user) => !needle || user.username.toLowerCase().includes(needle))
          .slice(0, 6)
          .map((user) => ({ id: `user-${user.id}`, kind: 'person', user }))
      : [];
  const pages = context
    .listPages()
    .filter((page) => page.id !== context.pageId)
    .filter((page) => !needle || (page.title || 'untitled').toLowerCase().includes(needle))
    .sort((a, b) => {
      const aStarts = (a.title || '').toLowerCase().startsWith(needle) ? 0 : 1;
      const bStarts = (b.title || '').toLowerCase().startsWith(needle) ? 0 : 1;
      return aStarts - bStarts || (a.title || '').localeCompare(b.title || '');
    })
    .slice(0, 8)
    .map((page) => ({ id: `page-${page.id}`, kind: 'page', page }));
  if (needle && canCreate) pages.push({ id: 'create', kind: 'create', title: query.trim() });
  return [...assignees, ...pages];
}

function mentionSuggestion(editor, char, pluginKey) {
  const isAt = char === '@';
  return Suggestion({
    editor,
    pluginKey,
    char,
    // "@" is common in ordinary text, so its menu is deliberately modest: it
    // ends at the first space and never offers to create a page. "[[" is an
    // explicit request for a link: titles with spaces, and "create" as well.
    allowSpaces: !isAt,
    allowedPrefixes: isAt ? [' ', '('] : null,
    allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
    items: ({ query }) => mentionItems(editor, query, { canCreate: !isAt, people: isAt }),
    command: ({ editor: target, range, props: item }) => {
      if (item.kind === 'person') {
        target
          .chain()
          .focus()
          .deleteRange(range)
          .command(({ tr, state }) => {
            const pos = enclosingTask(state);
            const node = pos === null ? null : tr.doc.nodeAt(pos);
            if (!node) return false;
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, assignee: item.user.id });
            return true;
          })
          .run();
        return;
      }
      if (item.kind === 'create') {
        target.chain().focus().deleteRange(range).run();
        const context = appContext(target);
        context.createSubPage(item.title).then((page) => {
          if (!page || target.isDestroyed) return;
          target
            .chain()
            .focus()
            .insertContent([{ type: 'pageMention', attrs: { pageId: page.id } }, { type: 'text', text: ' ' }])
            .run();
        });
        return;
      }
      target
        .chain()
        .focus()
        .insertContentAt(range, [
          { type: 'pageMention', attrs: { pageId: item.page.id } },
          { type: 'text', text: ' ' },
        ])
        .run();
    },
    render: createSuggestionRenderer({
      className: 'mention-menu',
      emptyText: 'No pages found',
      onEscape: (view) => exitSuggestion(view, pluginKey),
      renderItem: (item) =>
        item.kind === 'person'
          ? [
              h('span', { class: 'mention-icon' }, icon('user', 16)),
              h('span', { class: 'slash-title' }, item.user.username),
              h('span', { class: 'slash-hint' }, 'Assign'),
            ]
          : item.kind === 'create'
          ? [
              h('span', { class: 'mention-icon' }, icon('plus', 16)),
              h('span', { class: 'slash-title' }, `New sub-page “${item.title}”`),
            ]
          : [
              h('span', { class: 'mention-icon' }, item.page.icon || icon('file-text', 16)),
              h('span', { class: 'slash-title' }, item.page.title || 'Untitled'),
            ],
    }),
  });
}

/** "@" and "[[" open the page picker; pasting a page address makes a mention. */
export const PageMentions = Extension.create({
  name: 'pageMentions',

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      mentionSuggestion(editor, '@', new PluginKey('pageMentionAt')),
      mentionSuggestion(editor, '[[', new PluginKey('pageMentionBrackets')),
      new Plugin({
        key: new PluginKey('pageLinkPaste'),
        props: {
          handlePaste(view, event) {
            const text = event.clipboardData?.getData('text/plain')?.trim();
            if (!text || !text.startsWith(location.origin)) return false;
            const match = PAGE_URL.exec(text.slice(location.origin.length));
            const pageId = match ? Number(match[1]) : null;
            if (!pageId || !appContext(editor).getPage(pageId)) return false;
            if (view.state.selection.$from.parent.type.spec.code) return false;
            event.preventDefault();
            editor
              .chain()
              .focus()
              .insertContent([{ type: 'pageMention', attrs: { pageId } }, { type: 'text', text: ' ' }])
              .run();
            return true;
          },
        },
      }),
    ];
  },
});
