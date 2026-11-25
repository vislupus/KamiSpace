// Calculated properties: the editor of a formula, and the ready-made ones
// ("Number of days", "Working days"…) that are set up by choosing properties
// instead of writing anything.
import { h } from '../../lib/dom.js';
import { FUNCTION_LIST, propRef } from '../../lib/formula.js';
import { icon } from '../../lib/icons.js';
import { openPopover } from '../../lib/popover.js';
import { toast } from '../../lib/toast.js';
import { NUMBER_FORMATS, TYPES, formulaPreview, formulaProblem } from './values.js';

const GROUPS = ['Dates', 'Numbers', 'Logic', 'Text'];

/**
 * Write or change the formula of a property.
 * onSave({ expression, format }) is called once, when the editor closes with
 * a formula that can be calculated.
 */
export function openFormulaEditor({ anchor, prop, properties, sampleRow, onSave }) {
  let format = prop.format ?? 'number';
  let saved = false;
  const input = h('textarea', {
    class: 'db-formula-input',
    rows: 3,
    spellcheck: false,
    placeholder: 'prop("Price") * prop("Quantity")',
    'aria-label': 'Formula',
    value: prop.expression ?? '',
  });
  const result = h('div', { class: 'db-formula-result', role: 'status' });
  const others = properties.filter((item) => item.id !== prop.id);

  /** Put text where the caret is; `inside` moves the caret back into the brackets. */
  const insert = (text, inside = 0) => {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.setRangeText(text, start, end, 'end');
    const caret = input.selectionEnd - inside;
    input.setSelectionRange(caret, caret);
    input.focus();
    check();
  };

  function check() {
    const expression = input.value;
    if (!expression.trim()) {
      result.className = 'db-formula-result';
      result.textContent = 'Pick a property or a function below, or type a formula.';
      return null;
    }
    const problem = formulaProblem(expression, prop, properties);
    if (problem) {
      result.className = 'db-formula-result is-error';
      result.replaceChildren(icon('warning', 14), problem);
      return problem;
    }
    result.className = 'db-formula-result is-ok';
    if (sampleRow) {
      const preview = formulaPreview(expression, prop, properties, sampleRow);
      if (preview.error) {
        // Fine in general, but not for this row (a text where a number belongs…).
        result.className = 'db-formula-result is-error';
        result.replaceChildren(icon('warning', 14), `${sampleRow.title || 'First row'}: ${preview.error}`);
      } else {
        result.replaceChildren(icon('check', 14), `${sampleRow.title || 'First row'} = ${preview.text === '' ? '(empty)' : preview.text}`);
      }
    } else {
      result.replaceChildren(icon('check', 14), 'The formula is fine.');
    }
    return null;
  }

  const save = () => {
    if (saved) return true;
    const expression = input.value.trim();
    if (formulaProblem(expression, prop, properties)) return false;
    saved = true;
    if (expression !== (prop.expression ?? '') || format !== (prop.format ?? 'number')) onSave({ expression, format });
    return true;
  };

  const formats = h(
    'select',
    { class: 'select', 'aria-label': 'Show numbers as' },
    NUMBER_FORMATS.map(([key, label]) => h('option', { value: key, selected: key === format }, label)),
  );
  formats.addEventListener('change', () => {
    format = formats.value;
  });

  const content = h(
    'div',
    { class: 'db-formula-editor' },
    h('div', { class: 'db-formula-title' }, icon('formula', 15), h('span', null, prop.name)),
    input,
    result,
    others.length
      ? h(
          'div',
          { class: 'db-formula-section' },
          h('div', { class: 'menu-heading' }, 'Properties'),
          h(
            'div',
            { class: 'db-formula-chips' },
            others.map((item) =>
              h(
                'button',
                { class: 'db-formula-chip', type: 'button', title: `Insert ${propRef(item.name)}`, onclick: () => insert(propRef(item.name)) },
                icon(TYPES[item.type].icon, 13),
                item.name,
              ),
            ),
          ),
        )
      : null,
    h(
      'div',
      { class: 'db-formula-section db-formula-functions' },
      GROUPS.map((group) => [
        h('div', { class: 'menu-heading' }, group),
        FUNCTION_LIST.filter((item) => item.group === group).map((item) =>
          h(
            'button',
            {
              class: 'db-formula-function',
              type: 'button',
              onclick: () => (item.signature.endsWith('()') ? insert(`${item.name}()`) : insert(`${item.name}()`, 1)),
            },
            h('code', null, item.signature),
            h('span', null, item.about),
          ),
        ),
      ]),
    ),
    h(
      'div',
      { class: 'db-formula-foot' },
      h('label', { class: 'db-formula-format' }, 'Numbers as', formats),
      h(
        'button',
        {
          class: 'button button-primary button-small',
          type: 'button',
          onclick: () => {
            if (save()) popover.close();
            else input.focus();
          },
        },
        'Done',
      ),
    ),
  );
  input.addEventListener('input', check);
  input.addEventListener('keydown', (event) => {
    // Ctrl+Enter is "Done"; a plain Enter is a new line in the formula.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (save()) popover.close();
    }
  });
  const popover = openPopover({
    anchor,
    placement: 'bottom-start',
    offset: 2,
    className: 'db-formula-popover',
    content,
    restoreFocus: false,
    onClose: () => {
      if (!save()) toast('The formula has a mistake, so it was not saved.');
    },
  });
  check();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  return popover;
}

// -- ready-made formulas ------------------------------------------------------------------

const OPERATIONS = [
  ['+', 'plus (+)', (a, b) => `${a} + ${b}`, 'number'],
  ['-', 'minus (−)', (a, b) => `${a} - ${b}`, 'number'],
  ['*', 'times (×)', (a, b) => `${a} * ${b}`, 'number'],
  ['/', 'divided by (÷)', (a, b) => `round(${a} / ${b}, 2)`, 'number'],
  ['%', 'as a percentage of', (a, b) => `percent(${a}, ${b})`, 'percent'],
];

/** The calculated properties offered when a property is added. */
export const PRESETS = [
  { key: 'days', label: 'Number of days', icon: 'calendar-range', description: 'From a date to a date, both counted', name: 'Days' },
  { key: 'workdays', label: 'Working days', icon: 'briefcase', description: 'Without weekends and public holidays', name: 'Working days' },
  { key: 'daysUntil', label: 'Days left', icon: 'hourglass', description: 'From today to a date', name: 'Days left' },
  { key: 'math', label: 'Calculation', icon: 'calculator', description: 'Add, subtract, multiply, divide two numbers', name: 'Result' },
  { key: 'formula', label: 'Formula', icon: 'formula', description: 'Write your own', name: 'Formula' },
];

function select(label, options, value = null) {
  const el = h(
    'select',
    { class: 'select', 'aria-label': label },
    options.map(([key, text]) => h('option', { value: key, selected: key === value }, text)),
  );
  return el;
}

/**
 * Set up a ready-made formula by choosing the properties it works on.
 * onCreate({ name, expression, format }) is called when "Add" is pressed.
 */
export function openPresetBuilder({ preset, anchor, properties, placement = 'bottom-end', onCreate }) {
  const dates = properties.filter((prop) => prop.type === 'date');
  const numeric = properties.filter((prop) => prop.type === 'number' || prop.type === 'formula');
  const name = h('input', { class: 'input', type: 'text', value: preset.name, maxLength: 100, 'aria-label': 'Property name' });
  const fields = [];
  let build = null;
  let missing = null;

  const field = (label, control) => fields.push(h('label', { class: 'db-preset-field' }, h('span', null, label), control));
  const ref = (id) => propRef(properties.find((prop) => prop.id === id)?.name ?? '');

  if (preset.key === 'days' || preset.key === 'workdays') {
    if (!dates.length) missing = 'This counts the days of a date. Add a Date property first.';
    else {
      const from = select('From', dates.map((prop) => [prop.id, prop.name]));
      const to = select('To', [['', 'The end of the same date'], ...dates.map((prop) => [prop.id, prop.name])]);
      field('From', from);
      field('To', to);
      build = () => ({
        expression: to.value && to.value !== from.value ? `${preset.key}(${ref(from.value)}, ${ref(to.value)})` : `${preset.key}(${ref(from.value)})`,
        format: 'number',
      });
    }
  } else if (preset.key === 'daysUntil') {
    if (!dates.length) missing = 'This counts the days to a date. Add a Date property first.';
    else {
      const target = select('Date', dates.map((prop) => [prop.id, prop.name]));
      field('Date', target);
      build = () => ({ expression: `daysUntil(${ref(target.value)})`, format: 'number' });
    }
  } else if (preset.key === 'math') {
    if (!numeric.length) missing = 'This calculates with numbers. Add a Number property first.';
    else {
      const first = select('First value', numeric.map((prop) => [prop.id, prop.name]));
      const operation = select('Operation', OPERATIONS.map(([key, label]) => [key, label]), numeric.length > 1 ? '*' : '+');
      const second = select('Second value', [...numeric.map((prop) => [prop.id, prop.name]), ['', 'A number…']], numeric[1]?.id ?? '');
      const fixed = h('input', { class: 'input', type: 'text', inputMode: 'decimal', value: '1', 'aria-label': 'Number', hidden: second.value !== '' });
      second.addEventListener('change', () => {
        fixed.hidden = second.value !== '';
        if (!fixed.hidden) fixed.focus();
      });
      field('First value', first);
      field('Operation', operation);
      field('Second value', second);
      fields.push(fixed);
      build = () => {
        const constant = Number(fixed.value.trim().replace(',', '.'));
        if (second.value === '' && !Number.isFinite(constant)) return null;
        const [, , make, format] = OPERATIONS.find(([key]) => key === operation.value);
        return { expression: make(ref(first.value), second.value === '' ? String(constant) : ref(second.value)), format };
      };
    }
  }

  const add = h('button', { class: 'button button-primary button-small', type: 'button', disabled: Boolean(missing) }, 'Add');
  const submit = () => {
    const built = build?.();
    if (!built) return;
    popover.close();
    onCreate({ name: name.value.trim() || preset.name, ...built });
  };
  add.addEventListener('click', submit);
  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  });
  const popover = openPopover({
    anchor,
    placement,
    offset: 4,
    className: 'menu-popover',
    restoreFocus: false,
    content: h(
      'div',
      { class: 'db-preset' },
      h('div', { class: 'db-formula-title' }, icon(preset.icon, 15), h('span', null, preset.label)),
      missing ? h('div', { class: 'db-preset-missing' }, missing) : [h('label', { class: 'db-preset-field' }, h('span', null, 'Name'), name), fields],
      h('div', { class: 'db-formula-foot' }, h('span'), add),
    ),
  });
  if (!missing) {
    name.focus();
    name.select();
  }
  return popover;
}
