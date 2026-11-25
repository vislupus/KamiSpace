// Finding emoji by name, keyword or :shortcode:, in English and Bulgarian.
// Pure: it works on the list from src/data/emoji.json, wherever that came from.

const words = (text) =>
  text
    .toLowerCase()
    .split(/[|\s_:,.()\-–—]+/u)
    .filter(Boolean);

/**
 * The data file as objects, grouped the way the picker shows it.
 * @returns {{ groups: { name: string, sample: string, items: object[] }[], all: object[] }}
 */
export function prepareEmoji(data) {
  const groups = data.groups.map(([name, sample]) => ({ name, sample, items: [] }));
  const all = data.emoji.map(([char, group, name, english, bulgarian, code], order) => {
    const item = {
      char,
      group,
      name,
      // The Bulgarian name, when there is one: "палец нагоре".
      local: bulgarian.split('|')[0] || '',
      code,
      order,
      words: [...new Set([...words(name), ...words(english), ...words(bulgarian)])],
      phrases: [name.toLowerCase(), ...english.toLowerCase().split('|'), ...bulgarian.split('|')].filter(Boolean),
    };
    groups[group].items.push(item);
    return item;
  });
  return { groups, all };
}

/**
 * Emoji that match every word of the query, best first.
 * "thu" finds 👍 (thumbs up), "палец" too, and so does ":+1".
 */
export function searchEmoji(all, query, limit = 60) {
  const text = query.trim().toLowerCase().replace(/^:+|:+$/g, '');
  if (!text) return [];
  // An emoji typed or pasted into the box finds itself.
  const exact = all.filter((item) => item.char === query.trim() || item.char.replace(/️/g, '') === query.trim());
  if (exact.length) return exact;
  const phrase = text.replace(/_/g, ' ');
  const tokens = words(text);
  if (!tokens.length) return [];
  const found = [];
  for (const item of all) {
    let score = 0;
    for (const token of tokens) {
      let best = 0;
      for (const word of item.words) {
        if (word === token) {
          best = 4;
          break;
        }
        if (best < 3 && word.startsWith(token)) best = 3;
        else if (best < 1 && token.length > 2 && word.includes(token)) best = 1;
      }
      if (!best) {
        score = 0;
        break;
      }
      score += best;
    }
    if (!score) continue;
    // What was typed is the name, a keyword or the shortcode itself, or starts one.
    const name = item.name.toLowerCase();
    if (name === phrase || item.local === phrase) score += 12;
    else if (item.code === text) score += 9;
    else if (item.phrases.includes(phrase)) score += 6;
    else if (name.startsWith(phrase) || item.local.startsWith(phrase)) score += 3;
    else if (item.phrases.some((entry) => entry.startsWith(phrase))) score += 2;
    found.push({ item, score });
  }
  found.sort((a, b) => b.score - a.score || a.item.order - b.item.order);
  return found.slice(0, limit).map((entry) => entry.item);
}
