import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { prepareEmoji, searchEmoji } from '../src/lib/emoji-search.js';

const data = JSON.parse(readFileSync(new URL('../src/data/emoji.json', import.meta.url), 'utf8'));
const { groups, all } = prepareEmoji(data);
const find = (query, limit) => searchEmoji(all, query, limit).map((item) => item.char);

test('the whole emoji set is there, in nine groups', () => {
  assert.ok(all.length > 1800, `${all.length} emoji`);
  assert.equal(groups.length, 9);
  assert.ok(groups.every((group) => group.items.length > 10));
  assert.equal(new Set(all.map((item) => item.char)).size, all.length);
  assert.equal(groups.reduce((total, group) => total + group.items.length, 0), all.length);
});

test('search by English name, keyword and shortcode', () => {
  assert.equal(find('thumbs up')[0], '👍');
  assert.equal(find(':+1:')[0], '👍');
  assert.equal(find('thumbsup')[0], '👍');
  assert.equal(find('rocket')[0], '🚀');
  assert.equal(find('ROCKET')[0], '🚀');
  assert.equal(find('heart')[0], '❤️');
  assert.ok(find('smile').includes('😄'));
  assert.ok(find('heart').includes('❤️'));
  assert.ok(find('red heart').indexOf('❤️') === 0);
  assert.ok(find('fire').includes('🔥'));
  assert.equal(find('bulgaria')[0], '🇧🇬');
  assert.ok(find('check').includes('✅'));
});

test('search in Bulgarian', () => {
  assert.equal(find('палец нагоре')[0], '👍');
  assert.ok(find('сърце').includes('❤️'));
  assert.ok(find('ракета').includes('🚀'));
  assert.ok(find('куче').includes('🐶'));
  assert.equal(find('българия')[0], '🇧🇬');
  assert.ok(find('усмив').length > 3);
});

test('every word has to match; nothing matches nonsense', () => {
  assert.ok(find('cat face').includes('🐱'));
  assert.ok(!find('cat face').includes('🐶'));
  assert.deepEqual(find('qqqqzzzz'), []);
  assert.deepEqual(find('   '), []);
  assert.deepEqual(find('::'), []);
  assert.equal(find('face', 5).length, 5);
});

test('an emoji finds itself', () => {
  assert.deepEqual(find('🚀'), ['🚀']);
  assert.deepEqual(find('❤'), ['❤️']);
});
