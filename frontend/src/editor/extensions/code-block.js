import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { createLowlight } from 'lowlight';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';

const LANGUAGES = [
  ['bash', 'Bash', bash],
  ['c', 'C', c],
  ['cpp', 'C++', cpp],
  ['csharp', 'C#', csharp],
  ['css', 'CSS', css],
  ['diff', 'Diff', diff],
  ['dockerfile', 'Dockerfile', dockerfile],
  ['go', 'Go', go],
  ['xml', 'HTML / XML', xml],
  ['ini', 'INI / TOML', ini],
  ['java', 'Java', java],
  ['javascript', 'JavaScript', javascript],
  ['json', 'JSON', json],
  ['kotlin', 'Kotlin', kotlin],
  ['markdown', 'Markdown', markdown],
  ['php', 'PHP', php],
  ['python', 'Python', python],
  ['ruby', 'Ruby', ruby],
  ['rust', 'Rust', rust],
  ['sql', 'SQL', sql],
  ['typescript', 'TypeScript', typescript],
  ['yaml', 'YAML', yaml],
];

// Names people type after ``` that should map to a registered grammar.
const ALIASES = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python',
  sh: 'bash', shell: 'bash', zsh: 'bash', html: 'xml', yml: 'yaml', toml: 'ini', rb: 'ruby',
  rs: 'rust', golang: 'go', cs: 'csharp', md: 'markdown', docker: 'dockerfile', kt: 'kotlin',
};

const lowlight = createLowlight();
for (const [id, , grammar] of LANGUAGES) lowlight.register(id, grammar);
lowlight.registerAlias(
  Object.entries(ALIASES).reduce((groups, [alias, id]) => {
    (groups[id] ??= []).push(alias);
    return groups;
  }, {}),
);

function canonical(language) {
  if (!language) return '';
  const id = ALIASES[language] ?? language;
  return LANGUAGES.some(([known]) => known === id) ? id : '';
}

export const CodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;

      const select = h(
        'select',
        { class: 'code-language', 'aria-label': 'Language', contentEditable: 'false' },
        h('option', { value: '' }, 'Plain text'),
        LANGUAGES.map(([id, label]) => h('option', { value: id }, label)),
      );
      const copy = h(
        'button',
        {
          class: 'icon-button code-copy',
          type: 'button',
          title: 'Copy code',
          'aria-label': 'Copy code',
          contentEditable: 'false',
        },
        icon('copy', 14),
      );
      const code = h('code', { spellcheck: false });
      const pre = h('pre', null, code);
      const tools = h('div', { class: 'code-tools', contentEditable: 'false' }, select, copy);
      const dom = h('div', { class: 'code-block' }, tools, pre);

      const sync = () => {
        select.value = canonical(current.attrs.language);
        select.disabled = !editor.isEditable;
      };
      sync();

      select.addEventListener('change', () => {
        if (typeof getPos !== 'function') return;
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(getPos(), undefined, {
            ...current.attrs,
            language: select.value || null,
          }),
        );
        editor.commands.focus();
      });
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(current.textContent);
          copy.replaceChildren(icon('check', 14));
          setTimeout(() => copy.replaceChildren(icon('copy', 14)), 1200);
        } catch {
          // Clipboard access can be denied; nothing to do.
        }
      });

      return {
        dom,
        contentDOM: code,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated;
          sync();
          return true;
        },
        stopEvent(event) {
          return tools.contains(event.target);
        },
        ignoreMutation(mutation) {
          if (mutation.type === 'selection') return false;
          return !code.contains(mutation.target);
        },
      };
    };
  },
}).configure({
  lowlight,
  defaultLanguage: null,
  enableTabIndentation: true,
  tabSize: 2,
});
