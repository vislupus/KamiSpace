// Builds src/data/emoji.json: every emoji with what it can be found by, in
// English and in Bulgarian. The result is committed, so nothing is fetched
// when KamiSpace is built or run.
//
//   npm run emoji -- path/to/bg/annotations.json
//
// Sources:
//   - emojibase-data (a dev dependency): the emoji, their groups, English
//     names, keywords and :shortcodes:
//   - Unicode CLDR annotations for Bulgarian (names and keywords), from the
//     package "cldr-annotations-modern":
//         npm pack cldr-annotations-modern
//         tar -xzf cldr-annotations-modern-*.tgz package/annotations/bg/annotations.json
//     Without that file the Bulgarian words already in emoji.json are kept.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '../src/data/emoji.json');

const emoji = require('emojibase-data/en/compact.json');
const github = require('emojibase-data/en/shortcodes/github.json');
const emojibase = require('emojibase-data/en/shortcodes/emojibase.json');

// Group numbers of the Unicode emoji list; 2 ("components": skin tones, hair) is left out.
const GROUPS = [
  [0, 'Smileys & emotion', '😀'],
  [1, 'People & body', '👋'],
  [3, 'Animals & nature', '🐻'],
  [4, 'Food & drink', '🍎'],
  [5, 'Travel & places', '🚗'],
  [6, 'Activities', '⚽'],
  [7, 'Objects', '💡'],
  [8, 'Symbols', '❤️'],
  [9, 'Flags', '🏁'],
];
const groupIndex = new Map(GROUPS.map(([number], index) => [number, index]));

const bare = (text) => text.replace(/️/g, '');
let bulgarian = new Map();
const annotationsPath = process.argv[2];
if (annotationsPath) {
  const { annotations } = JSON.parse(readFileSync(annotationsPath, 'utf8')).annotations;
  for (const [key, value] of Object.entries(annotations)) {
    const name = value.tts?.[0] ?? '';
    const words = (value.default ?? []).filter((word) => word.toLowerCase() !== name.toLowerCase());
    bulgarian.set(bare(key), [name, ...words].join('|').toLowerCase());
  }
} else {
  try {
    for (const [character, , , , bg] of JSON.parse(readFileSync(target, 'utf8')).emoji) bulgarian.set(bare(character), bg);
  } catch {
    bulgarian = new Map();
  }
}

const list = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const rows = emoji
  .filter((item) => groupIndex.has(item.group))
  .sort((a, b) => a.order - b.order)
  .map((item) => {
    const codes = [...new Set([...list(github[item.hexcode]), ...list(emojibase[item.hexcode])])];
    const words = [...new Set([...(item.tags ?? []), ...codes])].filter((word) => word !== item.label);
    // CLDR names flags through its list of countries, which is not read here.
    const bg = bulgarian.get(bare(item.unicode)) ?? (item.hexcode === '1F1E7-1F1EC' ? 'знаме: българия|българия|знаме' : item.group === 9 ? 'знаме' : '');
    return [item.unicode, groupIndex.get(item.group), item.label, words.join('|'), bg, codes[0] ?? ''];
  });

writeFileSync(
  target,
  `${JSON.stringify({ groups: GROUPS.map(([, name, sample]) => [name, sample]), emoji: rows })}\n`,
);
const withBulgarian = rows.filter((row) => row[4]).length;
console.log(`${rows.length} emoji written to ${target} (${withBulgarian} with Bulgarian names).`);
