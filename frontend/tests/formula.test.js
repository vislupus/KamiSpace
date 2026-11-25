import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compile, dateValue, evaluate, references, renameProperty, toText } from '../src/lib/formula.js';

const row = {
  Price: 12.5,
  Quantity: 4,
  Name: 'Report',
  Done: true,
  Empty: null,
  Trip: dateValue('2026-11-23', '2026-11-27'),
  Start: dateValue('2026-12-22'),
  Finish: dateValue('2027-01-05'),
  Meeting: dateValue('2026-11-23T14:30', '2026-11-23T16:00'),
  Tags: ['red', 'blue'],
};
const scope = {
  today: '2026-11-25',
  now: '2026-11-25T10:00',
  prop(name) {
    const key = Object.keys(row).find((item) => item.toLowerCase() === name.toLowerCase());
    if (!key) throw new Error(`no property ${name}`);
    return row[key];
  },
};
const value = (source) => {
  const result = evaluate(source, scope);
  assert.equal(result.error, undefined, `${source} → ${result.error}`);
  return result.value;
};
const error = (source) => evaluate(source, scope).error;

test('arithmetic follows the usual order of operations', () => {
  assert.equal(value('1 + 2 * 3'), 7);
  assert.equal(value('(1 + 2) * 3'), 9);
  assert.equal(value('2 ^ 3 ^ 2'), 512);
  assert.equal(value('-2 ^ 2'), -4);
  assert.equal(value('10 % 4'), 2);
  assert.equal(value('7 / 2'), 3.5);
  assert.equal(value('0.1 + 0.2'), 0.3);
  assert.equal(value('2 × 3 − 1'), 5);
  assert.equal(value('prop("Price") * prop("Quantity")'), 50);
  assert.equal(value('prop("price")*prop("QUANTITY")'), 50);
});

test('empty values stay empty instead of failing', () => {
  assert.equal(value('prop("Empty") * 2'), null);
  assert.equal(value('prop("Price") / 0'), null);
  assert.equal(value('sum(prop("Price"), prop("Empty"), 1)'), 13.5);
  assert.equal(value('days(prop("Empty"))'), null);
  assert.equal(value('empty(prop("Empty"))'), true);
  assert.equal(value('prop("Empty") > 3'), false);
});

test('days counts both ends of a range', () => {
  assert.equal(value('days(prop("Trip"))'), 5);
  assert.equal(value('days(prop("Start"))'), 1);
  assert.equal(value('days(prop("Start"), prop("Finish"))'), 15);
  assert.equal(value('days(prop("Finish"), prop("Start"))'), -15);
  assert.equal(value('dateBetween(prop("Finish"), prop("Start"), "days")'), 14);
  assert.equal(value('prop("Finish") - prop("Start")'), 14);
  assert.equal(value('dateBetween(prop("Finish"), prop("Start"), "weeks")'), 2);
});

test('working days skip weekends and Bulgarian holidays', () => {
  // 23–27 November 2026 is Monday to Friday.
  assert.equal(value('workdays(prop("Trip"))'), 5);
  // 22 December 2026 – 5 January 2027: without two weekends, 24–26 December,
  // Monday the 28th (in lieu of Saturday the 26th) and 1 January.
  assert.equal(value('workdays(prop("Start"), prop("Finish"))'), 7);
  assert.equal(value('isWorkday(dateAdd(prop("Start"), 2, "days"))'), false);
});

test('today, distances to today and moving dates', () => {
  assert.equal(value('daysUntil(prop("Start"))'), 27);
  assert.equal(value('daysSince(prop("Trip"))'), 2);
  assert.equal(toText(value('dateAdd(prop("Start"), 1, "months")')), '22.01.2027');
  assert.equal(toText(value('dateSubtract(today(), 30, "days")')), '26.10.2026');
  assert.equal(toText(value('prop("Start") + 10')), '01.01.2027');
  assert.equal(toText(value('end(prop("Trip"))')), '27.11.2026');
  assert.equal(value('year(prop("Finish"))'), 2027);
  assert.equal(value('weekday(prop("Trip"))'), 1);
  assert.equal(value('week(prop("Finish"))'), 1);
  assert.equal(value('hours(prop("Meeting"))'), 1.5);
  assert.equal(value('dateBetween(end(prop("Meeting")), prop("Meeting"), "minutes")'), 90);
  assert.equal(value('dateBetween(prop("Finish"), prop("Start"), "months")'), 0);
});

test('a day is 23 or 25 hours long when the clock changes', () => {
  assert.equal(evaluate('hours(prop("d"))', { prop: () => dateValue('2026-03-29T00:00', '2026-03-30T00:00') }).value, 23);
  assert.equal(evaluate('hours(prop("d"))', { prop: () => dateValue('2026-10-25T00:00', '2026-10-26T00:00') }).value, 25);
});

test('conditions, comparisons and logic', () => {
  assert.equal(value('if(prop("Price") > 10, "expensive", "cheap")'), 'expensive');
  assert.equal(value('if(daysUntil(prop("Trip")) < 0 and not prop("Empty"), "Late", "On time")'), 'Late');
  assert.equal(value('if(false, 1)'), null);
  assert.equal(value('prop("Done") and prop("Price") >= 12.5'), true);
  assert.equal(value('1 = 1 or 1 / 0'), true);
  assert.equal(value('prop("Name") == "report"'), true);
  assert.equal(value('prop("Start") < prop("Finish")'), true);
  assert.equal(value('not true || 2 != 2'), false);
  // Only the chosen branch is calculated.
  assert.equal(value('if(true, 1, sqrt("x"))'), 1);
});

test('numbers and texts', () => {
  assert.equal(value('round(1.005, 2)'), 1.01);
  assert.equal(value('round(-2.5)'), -3);
  assert.equal(value('round(prop("Price") / 3, 1)'), 4.2);
  assert.equal(value('percent(1, 3)'), 33.3);
  assert.equal(value('min(3, 1, 2) + max(3, 1, 2) + abs(-1)'), 5);
  assert.equal(value('average(2, 4, prop("Empty"))'), 3);
  assert.equal(value('floor(2.9) + ceil(2.1)'), 5);
  assert.equal(value('toNumber("12,5") * 2'), 25);
  assert.equal(value('prop("Name") + " × " + prop("Quantity")'), 'Report × 4');
  assert.equal(value('concat(upper(prop("Name")), "!")'), 'REPORT!');
  assert.equal(value('length(prop("Tags")) + length("абв")'), 5);
  assert.equal(value('join(prop("Tags"), " / ")'), 'red / blue');
  assert.equal(value('contains(prop("Tags"), "Blue") and contains(prop("Name"), "PORT")'), true);
  assert.equal(value("replace('a-b-c', '-', '+')"), 'a+b+c');
  assert.equal(value('formatDate(prop("Trip"))'), '23.11.2026 → 27.11.2026');
});

test('mistakes are explained, never thrown', () => {
  assert.match(error(''), /empty/);
  assert.match(error('1 +'), /not finished/);
  assert.match(error('(1 + 2'), /missing/);
  assert.match(error('nope(1)'), /no function/);
  assert.match(error('Price * 2'), /prop\("Price"\)/);
  assert.match(error('"abc'), /closing quote/);
  assert.match(error('round()'), /takes/);
  assert.match(error('1 2'), /Unexpected/);
  assert.match(error('sqrt("x")'), /needs a number/);
  assert.match(error('days("x")'), /needs a date/);
  assert.match(error('dateAdd(today(), 1, "fortnights")'), /unit/);
  assert.match(error('2 $ 3'), /Unexpected/);
  assert.equal(compile('1 +').tree, undefined);
});

test('the properties a formula reads can be listed and renamed', () => {
  assert.deepEqual(references('prop("A") + if(prop("B") > 1, prop("A"), prop("C d"))'), ['A', 'B', 'C d']);
  assert.equal(renameProperty('prop("Price") * prop( "price" ) + "Price"', 'Price', 'Unit "cost"'), 'prop("Unit \\"cost\\"") * prop( "Unit \\"cost\\"" ) + "Price"');
  assert.equal(value(renameProperty('prop("Price") * 2', 'price', 'Quantity')), 8);
  assert.equal(renameProperty('prop("Price', 'Price', 'X'), 'prop("Price');
});
