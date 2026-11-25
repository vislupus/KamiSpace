// Formulas of a database: a small expression language calculated from the
// values of one row. No DOM and no eval: the text is parsed into a tree and
// the tree is walked.
//
//   prop("Price") * prop("Quantity")
//   days(prop("Date"))                       days in a date range, both ends counted
//   if(daysUntil(prop("Deadline")) < 0, "Late", "On time")
//
// Values are numbers, texts, true/false, dates ({ start, end }), lists and
// "empty" (null). Empty goes through arithmetic as empty, so a row that is
// not filled in yet shows nothing rather than an error.
import {
  addDays,
  addMonths,
  daysBetween,
  formatDateTime,
  fromSofia,
  isDayOff,
  isValidDate,
  isoWeek,
  now,
  parts,
  toSofia,
  weekday,
} from './bgcalendar.js';

export class FormulaError extends Error {}

const fail = (message) => {
  throw new FormulaError(message);
};

// -- values -----------------------------------------------------------------------------

/** A date value: a day ("2026-11-23") or a moment ("2026-11-23T14:30"), with an optional end. */
export function dateValue(start, end = null) {
  return { type: 'date', start, end: end && end !== start ? end : null };
}

export const isDate = (value) => Boolean(value) && typeof value === 'object' && value.type === 'date';
const isList = Array.isArray;
const isNothing = (value) => value === null || value === undefined || value === '' || (isList(value) && !value.length);

const day = (moment) => moment.slice(0, 10);
const hasTime = (moment) => moment.length > 10;
const withTime = (moment) => (hasTime(moment) ? moment : `${moment}T00:00`);

function truthy(value) {
  if (isNothing(value)) return false;
  if (typeof value === 'number') return value !== 0;
  return value !== false;
}

/** How a value reads as text (also what `+` uses to join texts). */
export function toText(value) {
  if (isNothing(value)) return '';
  if (isDate(value)) return value.end ? `${formatDateTime(value.start)} → ${formatDateTime(value.end)}` : formatDateTime(value.start);
  if (isList(value)) return value.map(toText).join(', ');
  if (typeof value === 'number') return String(Math.round(value * 1e10) / 1e10);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (isNothing(value)) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const parsed = Number(value.trim().replace(/\s/g, '').replace(',', '.').replace(/%$/, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function number(value, name) {
  if (isNothing(value)) return null;
  const parsed = toNumber(value);
  if (parsed === null) fail(`${name} needs a number`);
  return parsed;
}

function date(value, name) {
  if (isNothing(value)) return null;
  if (isDate(value)) return value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (isValidDate(text.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(text)) return dateValue(text);
  }
  return fail(`${name} needs a date`);
}

const finite = (value) => (Number.isFinite(value) ? Math.round(value * 1e10) / 1e10 : null);

// -- parsing ------------------------------------------------------------------------------

const SYMBOLS = ['==', '!=', '<=', '>=', '&&', '||', '≠', '≤', '≥', '+', '-', '*', '/', '%', '^', '<', '>', '=', '!', '(', ')', ',', '×', '÷', '−'];
const ALIASES = { '×': '*', '÷': '/', '−': '-', '≠': '!=', '≤': '<=', '≥': '>=', '=': '==', '&&': 'and', '||': 'or', '!': 'not' };

function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(source[index + 1] ?? ''))) {
      const match = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(source.slice(index));
      tokens.push({ type: 'number', value: Number(match[0]), at: index });
      index += match[0].length;
      continue;
    }
    if (char === '"' || char === "'" || char === '“' || char === '„') {
      const closing = char === '“' || char === '„' ? /[”“"]/ : new RegExp(char);
      let text = '';
      let cursor = index + 1;
      for (; cursor < source.length && !closing.test(source[cursor]); cursor += 1) {
        if (source[cursor] === '\\' && cursor + 1 < source.length) cursor += 1;
        text += source[cursor];
      }
      if (cursor >= source.length) fail('A text is missing its closing quote');
      tokens.push({ type: 'text', value: text, at: index, end: cursor + 1 });
      index = cursor + 1;
      continue;
    }
    if (/[\p{L}_]/u.test(char)) {
      const match = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(source.slice(index));
      const word = match[0];
      const lower = word.toLowerCase();
      if (lower === 'and' || lower === 'or' || lower === 'not') tokens.push({ type: 'symbol', value: lower, at: index });
      else tokens.push({ type: 'name', value: word, at: index });
      index += word.length;
      continue;
    }
    const symbol = SYMBOLS.find((item) => source.startsWith(item, index));
    if (!symbol) fail(`Unexpected “${char}”`);
    tokens.push({ type: 'symbol', value: ALIASES[symbol] ?? symbol, at: index });
    index += symbol.length;
  }
  return tokens;
}

const BINARY = [['or'], ['and'], ['==', '!=', '<', '<=', '>', '>='], ['+', '-'], ['*', '/', '%']];

function parse(source) {
  const tokens = tokenize(source);
  let position = 0;
  const peek = () => tokens[position];
  const isSymbol = (value) => peek()?.type === 'symbol' && peek().value === value;
  const take = (value) => {
    if (!isSymbol(value)) return false;
    position += 1;
    return true;
  };
  const expect = (value) => {
    if (!take(value)) fail(peek() ? `Expected “${value}”` : `Something is missing at the end: “${value}”`);
  };

  function binary(level) {
    if (level === BINARY.length) return unary();
    let left = binary(level + 1);
    for (;;) {
      const operator = BINARY[level].find((symbol) => isSymbol(symbol));
      if (!operator) return left;
      position += 1;
      left = { type: 'binary', operator, left, right: binary(level + 1) };
    }
  }

  function unary() {
    if (take('-')) return { type: 'negate', value: unary() };
    if (take('+')) return unary();
    if (take('not')) return { type: 'not', value: unary() };
    return power();
  }

  function power() {
    const base = primary();
    // Right to left: 2 ^ 3 ^ 2 is 2 ^ 9.
    if (take('^')) return { type: 'binary', operator: '^', left: base, right: unary() };
    return base;
  }

  function primary() {
    const token = peek();
    if (!token) fail('The formula is not finished');
    position += 1;
    if (token.type === 'number') return { type: 'value', value: token.value };
    if (token.type === 'text') return { type: 'value', value: token.value };
    if (token.type === 'symbol' && token.value === '(') {
      const inner = binary(0);
      expect(')');
      return inner;
    }
    if (token.type === 'name') {
      const lower = token.value.toLowerCase();
      if (!isSymbol('(')) {
        if (lower === 'true') return { type: 'value', value: true };
        if (lower === 'false') return { type: 'value', value: false };
        if (lower === 'pi') return { type: 'value', value: Math.PI };
        fail(`“${token.value}” is not known. A property is written prop("${token.value}")`);
      }
      position += 1;
      const args = [];
      if (!take(')')) {
        do args.push(binary(0));
        while (take(','));
        expect(')');
      }
      if (lower === 'prop') {
        if (args.length !== 1 || args[0].type !== 'value' || typeof args[0].value !== 'string') {
          fail('prop needs the name of a property in quotes: prop("Name")');
        }
        return { type: 'prop', name: args[0].value };
      }
      const definition = FUNCTIONS.get(lower);
      if (!definition) fail(`There is no function “${token.value}”`);
      const [least, most] = definition.args;
      if (args.length < least || args.length > most) {
        fail(`${definition.name} takes ${least === most ? least : most === Infinity ? `at least ${least}` : `${least} to ${most}`} value${most === 1 ? '' : 's'}`);
      }
      return { type: 'call', definition, args };
    }
    return fail(`Unexpected “${token.value}”`);
  }

  if (!tokens.length) fail('The formula is empty');
  const tree = binary(0);
  if (position < tokens.length) fail(`Unexpected “${tokens[position].value}”`);
  return tree;
}

// -- calculating ----------------------------------------------------------------------------

function compare(left, right) {
  if (isDate(left) && isDate(right)) {
    const a = withTime(left.start);
    const b = withTime(right.start);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  const a = toNumber(left);
  const b = toNumber(right);
  if (typeof left !== 'string' && typeof right !== 'string' && a !== null && b !== null) return a - b;
  return toText(left).localeCompare(toText(right), undefined, { sensitivity: 'accent' });
}

function equal(left, right) {
  if (isNothing(left) || isNothing(right)) return isNothing(left) && isNothing(right);
  if (isDate(left) && isDate(right)) return left.start === right.start && left.end === right.end;
  if (isList(left) || isList(right)) return toText(left) === toText(right);
  return compare(left, right) === 0;
}

const UNITS = {
  minute: 'minutes', minutes: 'minutes', hour: 'hours', hours: 'hours', day: 'days', days: 'days',
  week: 'weeks', weeks: 'weeks', month: 'months', months: 'months', year: 'years', years: 'years',
};

function unit(value, name) {
  const key = UNITS[String(value ?? 'days').toLowerCase()];
  return key ?? fail(`${name}: the unit is "days", "weeks", "months", "years", "hours" or "minutes"`);
}

function shift(moment, amount, by) {
  if (by === 'days' || by === 'weeks') {
    const days = Math.round(amount * (by === 'weeks' ? 7 : 1));
    return addDays(day(moment), days) + moment.slice(10);
  }
  if (by === 'months' || by === 'years') {
    return addMonths(day(moment), Math.round(amount * (by === 'years' ? 12 : 1))) + moment.slice(10);
  }
  // Hours and minutes: on the clock of Sofia, across a change of the clock.
  const minutes = Math.round(amount * (by === 'hours' ? 60 : 1));
  return toSofia(fromSofia(withTime(moment)) + minutes * 60_000);
}

function add(value, amount, by) {
  return dateValue(shift(value.start, amount, by), value.end ? shift(value.end, amount, by) : null);
}

/** `later` minus `earlier`, in a unit; whole units only, like Notion's dateBetween. */
function between(later, earlier, by) {
  if (by === 'days' || by === 'weeks') {
    const days = daysBetween(day(earlier), day(later));
    return by === 'weeks' ? Math.trunc(days / 7) : days;
  }
  if (by === 'months' || by === 'years') {
    const a = parts(later);
    const b = parts(earlier);
    let months = (a.year - b.year) * 12 + (a.month - b.month);
    // A month only counts once its day of the month is reached.
    if (months > 0 && a.day < b.day) months -= 1;
    if (months < 0 && a.day > b.day) months += 1;
    return by === 'years' ? Math.trunc(months / 12) : months;
  }
  const minutes = Math.round((fromSofia(withTime(later)) - fromSofia(withTime(earlier))) / 60_000);
  return by === 'hours' ? Math.trunc(minutes / 60) : minutes;
}

const MAX_SPAN = 36_600; // a century of days is as far as a loop over days goes

/** [first day, last day] of one date (its range) or of two dates. */
function span(args, name) {
  const first = date(args[0], name);
  if (first === null) return null;
  if (args.length === 1) return [day(first.start), day(first.end ?? first.start)];
  const second = date(args[1], name);
  if (second === null) return null;
  return [day(first.start), day(second.start)];
}

/** Days from the first to the last, both counted; negative when they run backwards. */
function countDays(range, counts = () => true) {
  if (range === null) return null;
  let [from, to] = range;
  const sign = from <= to ? 1 : -1;
  if (sign < 0) [from, to] = [to, from];
  if (daysBetween(from, to) > MAX_SPAN) fail('The dates are too far apart');
  let total = 0;
  for (let current = from; current <= to; current = addDays(current, 1)) {
    if (counts(current)) total += 1;
  }
  return sign * total;
}

function numbers(args, name) {
  return args
    .flat(Infinity)
    .filter((value) => !isNothing(value))
    .map((value) => number(value, name));
}

const round = (value, digits = 0) => {
  const factor = 10 ** Math.max(0, Math.min(10, Math.round(digits ?? 0)));
  // Half away from zero, on the decimal value people see (1.005 → 1.01).
  return (Math.sign(value) * Math.round(Math.abs(value) * factor + 1e-9)) / factor;
};

const one = (name, apply) => (args) => {
  const value = number(args[0], name);
  return value === null ? null : finite(apply(value));
};

const ofDate = (name, apply) => (args, scope) => {
  const value = date(args[0], name);
  return value === null ? null : apply(value, scope);
};

const today = (scope) => scope.today ?? now().date;

/**
 * name → { name, args: [least, most], group, signature, about, lazy?, run(args, scope) }.
 * `signature` and `about` are what the formula editor shows.
 */
const DEFINITIONS = [
  // Dates
  ['days', [1, 2], 'Dates', 'days(date) · days(from, to)', 'Days in a date range, or from one date to another. Both ends are counted: Monday to Friday is 5.', (args) => countDays(span(args, 'days'))],
  ['workdays', [1, 2], 'Dates', 'workdays(date) · workdays(from, to)', 'Like days, without Saturdays, Sundays and Bulgarian public holidays.', (args) => countDays(span(args, 'workdays'), (current) => !isDayOff(current))],
  ['daysUntil', [1, 1], 'Dates', 'daysUntil(date)', 'Days from today to the date: 0 today, 1 tomorrow, negative when it has passed.', ofDate('daysUntil', (value, scope) => daysBetween(today(scope), day(value.start)))],
  ['daysSince', [1, 1], 'Dates', 'daysSince(date)', 'Days from the date to today.', ofDate('daysSince', (value, scope) => daysBetween(day(value.start), today(scope)))],
  ['dateBetween', [2, 3], 'Dates', 'dateBetween(later, earlier, "days")', 'The first date minus the second, in "days", "weeks", "months", "years", "hours" or "minutes".', (args) => {
    const later = date(args[0], 'dateBetween');
    const earlier = date(args[1], 'dateBetween');
    return later === null || earlier === null ? null : between(later.start, earlier.start, unit(args[2], 'dateBetween'));
  }],
  ['hours', [1, 2], 'Dates', 'hours(date) · hours(from, to)', 'Hours from the start to the end of a date with times.', (args) => {
    const first = date(args[0], 'hours');
    const second = args.length > 1 ? date(args[1], 'hours') : first;
    if (first === null || second === null) return null;
    const end = args.length > 1 ? second.start : (first.end ?? first.start);
    return finite((fromSofia(withTime(end)) - fromSofia(withTime(first.start))) / 3_600_000);
  }],
  ['dateAdd', [2, 3], 'Dates', 'dateAdd(date, 7, "days")', 'The date moved later by a number of days, weeks, months, years, hours or minutes.', (args) => {
    const value = date(args[0], 'dateAdd');
    const amount = number(args[1], 'dateAdd');
    return value === null || amount === null ? null : add(value, amount, unit(args[2], 'dateAdd'));
  }],
  ['dateSubtract', [2, 3], 'Dates', 'dateSubtract(date, 7, "days")', 'The date moved earlier.', (args) => {
    const value = date(args[0], 'dateSubtract');
    const amount = number(args[1], 'dateSubtract');
    return value === null || amount === null ? null : add(value, -amount, unit(args[2], 'dateSubtract'));
  }],
  ['start', [1, 1], 'Dates', 'start(date)', 'The first day of a date range.', ofDate('start', (value) => dateValue(value.start))],
  ['end', [1, 1], 'Dates', 'end(date)', 'The last day of a date range (the date itself when it has no end).', ofDate('end', (value) => dateValue(value.end ?? value.start))],
  ['today', [0, 0], 'Dates', 'today()', 'Today, in Sofia.', (_args, scope) => dateValue(today(scope))],
  ['now', [0, 0], 'Dates', 'now()', 'This minute, in Sofia.', (_args, scope) => dateValue(scope.now ?? `${now().date}T${now().time}`)],
  ['year', [1, 1], 'Dates', 'year(date)', 'The year of a date.', ofDate('year', (value) => parts(value.start).year)],
  ['month', [1, 1], 'Dates', 'month(date)', 'The month of a date, 1 to 12.', ofDate('month', (value) => parts(value.start).month)],
  ['day', [1, 1], 'Dates', 'day(date)', 'The day of the month.', ofDate('day', (value) => parts(value.start).day)],
  ['weekday', [1, 1], 'Dates', 'weekday(date)', 'The day of the week: 1 is Monday, 7 is Sunday.', ofDate('weekday', (value) => weekday(day(value.start)))],
  ['week', [1, 1], 'Dates', 'week(date)', 'The ISO week of the year.', ofDate('week', (value) => isoWeek(day(value.start)).week)],
  ['isWorkday', [1, 1], 'Dates', 'isWorkday(date)', 'True unless the day is a Saturday, a Sunday or a public holiday.', ofDate('isWorkday', (value) => !isDayOff(day(value.start)))],
  ['formatDate', [1, 1], 'Dates', 'formatDate(date)', 'The date as text: 23.11.2026.', ofDate('formatDate', (value) => toText(value))],

  // Numbers
  ['round', [1, 2], 'Numbers', 'round(number, 2)', 'Rounded to a number of decimals (none when left out).', (args) => {
    const value = number(args[0], 'round');
    return value === null ? null : round(value, number(args[1] ?? 0, 'round'));
  }],
  ['floor', [1, 1], 'Numbers', 'floor(number)', 'Rounded down.', one('floor', Math.floor)],
  ['ceil', [1, 1], 'Numbers', 'ceil(number)', 'Rounded up.', one('ceil', Math.ceil)],
  ['abs', [1, 1], 'Numbers', 'abs(number)', 'Without its sign.', one('abs', Math.abs)],
  ['sqrt', [1, 1], 'Numbers', 'sqrt(number)', 'The square root.', one('sqrt', Math.sqrt)],
  ['pow', [2, 2], 'Numbers', 'pow(number, 2)', 'Raised to a power (also written number ^ 2).', (args) => {
    const base = number(args[0], 'pow');
    const exponent = number(args[1], 'pow');
    return base === null || exponent === null ? null : finite(base ** exponent);
  }],
  ['mod', [2, 2], 'Numbers', 'mod(number, 7)', 'What is left after dividing.', (args) => {
    const left = number(args[0], 'mod');
    const right = number(args[1], 'mod');
    return left === null || right === null || right === 0 ? null : finite(left % right);
  }],
  ['min', [1, Infinity], 'Numbers', 'min(a, b, …)', 'The smallest of the numbers.', (args) => {
    const list = numbers(args, 'min');
    return list.length ? Math.min(...list) : null;
  }],
  ['max', [1, Infinity], 'Numbers', 'max(a, b, …)', 'The largest of the numbers.', (args) => {
    const list = numbers(args, 'max');
    return list.length ? Math.max(...list) : null;
  }],
  ['sum', [1, Infinity], 'Numbers', 'sum(a, b, …)', 'The numbers added up; empty ones are skipped.', (args) => {
    const list = numbers(args, 'sum');
    return list.length ? finite(list.reduce((total, value) => total + value, 0)) : null;
  }],
  ['average', [1, Infinity], 'Numbers', 'average(a, b, …)', 'The mean of the numbers; empty ones are skipped.', (args) => {
    const list = numbers(args, 'average');
    return list.length ? finite(list.reduce((total, value) => total + value, 0) / list.length) : null;
  }],
  ['percent', [2, 3], 'Numbers', 'percent(part, whole)', 'The part as a percentage of the whole, to one decimal.', (args) => {
    const part = number(args[0], 'percent');
    const whole = number(args[1], 'percent');
    return part === null || !whole ? null : round((part / whole) * 100, number(args[2] ?? 1, 'percent'));
  }],
  ['toNumber', [1, 1], 'Numbers', 'toNumber(value)', 'A text such as "12,5" as a number.', (args) => toNumber(args[0])],

  // Logic
  ['if', [2, 3], 'Logic', 'if(condition, then, otherwise)', 'One value when the condition holds, another when it does not.', null],
  ['empty', [1, 1], 'Logic', 'empty(value)', 'True when there is no value.', (args) => isNothing(args[0])],
  ['not', [1, 1], 'Logic', 'not(value)', 'True becomes false and the other way round (also written not value).', (args) => !truthy(args[0])],
  ['and', [1, Infinity], 'Logic', 'and(a, b, …)', 'True when all of them are (also written a and b).', (args) => args.every(truthy)],
  ['or', [1, Infinity], 'Logic', 'or(a, b, …)', 'True when at least one is (also written a or b).', (args) => args.some(truthy)],

  // Text
  ['concat', [1, Infinity], 'Text', 'concat(a, b, …)', 'The values joined into one text (also written a + b).', (args) => args.map(toText).join('')],
  ['join', [1, 2], 'Text', 'join(list, ", ")', 'The entries of a multi-select or of people, joined with a separator.', (args) => (isList(args[0]) ? args[0] : [args[0]]).map(toText).filter(Boolean).join(toText(args[1] ?? ', '))],
  ['length', [1, 1], 'Text', 'length(value)', 'The number of characters of a text, or of entries of a list.', (args) => (isList(args[0]) ? args[0].length : [...toText(args[0])].length)],
  ['lower', [1, 1], 'Text', 'lower(text)', 'In small letters.', (args) => toText(args[0]).toLowerCase()],
  ['upper', [1, 1], 'Text', 'upper(text)', 'In capital letters.', (args) => toText(args[0]).toUpperCase()],
  ['trim', [1, 1], 'Text', 'trim(text)', 'Without spaces at the ends.', (args) => toText(args[0]).trim()],
  ['contains', [2, 2], 'Text', 'contains(text, "part")', 'True when the text (or the list) contains the part; capitals do not matter.', (args) => {
    const needle = toText(args[1]).toLowerCase();
    if (isList(args[0])) return args[0].some((item) => toText(item).toLowerCase() === needle);
    return needle !== '' && toText(args[0]).toLowerCase().includes(needle);
  }],
  ['replace', [3, 3], 'Text', 'replace(text, "old", "new")', 'Every “old” in the text replaced by “new”.', (args) => (toText(args[1]) ? toText(args[0]).split(toText(args[1])).join(toText(args[2])) : toText(args[0]))],
  ['format', [1, 1], 'Text', 'format(value)', 'Any value as text.', (args) => toText(args[0])],
];

const FUNCTIONS = new Map(
  DEFINITIONS.map(([name, args, group, signature, about, run]) => [name.toLowerCase(), { name, args, group, signature, about, run }]),
);

/** What the editor lists: [{ name, group, signature, about }]. */
export const FUNCTION_LIST = [...FUNCTIONS.values()].map(({ name, group, signature, about }) => ({ name, group, signature, about }));

function arithmetic(operator, left, right) {
  if (operator === '+') {
    if (isDate(left) && !isDate(right)) return isNothing(right) ? left : add(left, number(right, '+'), 'days');
    if (isDate(right) && !isDate(left)) return isNothing(left) ? right : add(right, number(left, '+'), 'days');
    if (typeof left === 'string' || typeof right === 'string' || isList(left) || isList(right)) return toText(left) + toText(right);
  }
  if (operator === '-') {
    if (isDate(left) && isDate(right)) return between(left.start, right.start, 'days');
    if (isDate(left)) return isNothing(right) ? left : add(left, -number(right, '-'), 'days');
  }
  if (isNothing(left) || isNothing(right)) return null;
  const a = number(left, operator);
  const b = number(right, operator);
  switch (operator) {
    case '+':
      return finite(a + b);
    case '-':
      return finite(a - b);
    case '*':
      return finite(a * b);
    case '/':
      return b === 0 ? null : finite(a / b);
    case '%':
      return b === 0 ? null : finite(a % b);
    default:
      return finite(a ** b);
  }
}

function run(node, scope) {
  switch (node.type) {
    case 'value':
      return node.value;
    case 'prop':
      return scope.prop(node.name);
    case 'negate': {
      const value = number(run(node.value, scope), '-');
      return value === null ? null : -value;
    }
    case 'not':
      return !truthy(run(node.value, scope));
    case 'binary': {
      const { operator } = node;
      // "and" and "or" stop as soon as the answer is known.
      if (operator === 'and') return truthy(run(node.left, scope)) && truthy(run(node.right, scope));
      if (operator === 'or') return truthy(run(node.left, scope)) || truthy(run(node.right, scope));
      const left = run(node.left, scope);
      const right = run(node.right, scope);
      if (operator === '==') return equal(left, right);
      if (operator === '!=') return !equal(left, right);
      if (['<', '<=', '>', '>='].includes(operator)) {
        if (isNothing(left) || isNothing(right)) return false;
        const order = compare(left, right);
        return operator === '<' ? order < 0 : operator === '<=' ? order <= 0 : operator === '>' ? order > 0 : order >= 0;
      }
      return arithmetic(operator, left, right);
    }
    case 'call': {
      // Only the branch that is chosen is calculated.
      if (node.definition.name === 'if') {
        const chosen = truthy(run(node.args[0], scope)) ? node.args[1] : node.args[2];
        return chosen ? run(chosen, scope) : null;
      }
      return node.definition.run(node.args.map((arg) => run(arg, scope)), scope);
    }
    default:
      return null;
  }
}

// -- the outside --------------------------------------------------------------------------

const compiled = new Map();

/** { tree } or { error } for a formula text. Parsed once per text. */
export function compile(source) {
  const text = String(source ?? '');
  let result = compiled.get(text);
  if (!result) {
    try {
      result = { tree: parse(text) };
    } catch (error) {
      if (!(error instanceof FormulaError)) throw error;
      result = { error: error.message };
    }
    if (compiled.size > 500) compiled.clear();
    compiled.set(text, result);
  }
  return result;
}

/**
 * Calculate a formula.
 * @param {string} source
 * @param {{ prop(name: string): unknown, today?: string, now?: string }} scope
 * @returns {{ value: unknown } | { error: string }}
 */
export function evaluate(source, scope) {
  const { tree, error } = compile(source);
  if (error) return { error };
  try {
    const value = run(tree, scope);
    return { value: isNothing(value) ? null : value };
  } catch (failure) {
    if (failure instanceof FormulaError) return { error: failure.message };
    if (failure instanceof RangeError) return { error: 'The formula refers to itself' };
    throw failure;
  }
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const key of ['left', 'right', 'value']) if (node[key] && typeof node[key] === 'object') walk(node[key], visit);
  for (const arg of node.args ?? []) walk(arg, visit);
}

/** The names of the properties a formula reads. */
export function references(source) {
  const { tree } = compile(source);
  const names = [];
  walk(tree, (node) => {
    if (node.type === 'prop' && !names.includes(node.name)) names.push(node.name);
  });
  return names;
}

export function quote(name) {
  return `"${String(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** prop("Name"), the way a property is written in a formula. */
export const propRef = (name) => `prop(${quote(name)})`;

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The formula with every prop("from") turned into prop("to"). */
export function renameProperty(source, from, to) {
  let tokens;
  try {
    tokens = tokenize(String(source ?? ''));
  } catch {
    return source;
  }
  let result = '';
  let cursor = 0;
  tokens.forEach((token, index) => {
    const isArgument =
      token.type === 'text' &&
      tokens[index - 1]?.value === '(' &&
      tokens[index - 2]?.type === 'name' &&
      tokens[index - 2].value.toLowerCase() === 'prop';
    if (!isArgument || !sameName(token.value, from)) return;
    result += source.slice(cursor, token.at) + quote(to);
    cursor = token.end;
  });
  return result + source.slice(cursor);
}

export { sameName };
