// Which emoji this computer can draw. The list is newer than most systems'
// fonts: an emoji the font does not know comes out as an empty box, as the
// digits of its code, as two letters (flags on Windows) or as the separate
// parts of a combined emoji. Those are left out of the picker.
//
// The test draws every emoji on a small canvas in red. A real emoji keeps its
// own colours; a stand-in is drawn in the colour it is given. The answer is
// remembered in the browser, so the drawing happens once per computer.
import { storageGet, storageSet } from './util.js';

const SIZE = 20;
const WIDTH = 72;
const HEIGHT = 30;
const FONT = `${SIZE}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif`;
const CACHE_KEY = 'kamispace-emoji-missing';

function createProbe() {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.font = FONT;
  context.textBaseline = 'top';
  context.fillStyle = '#f00';
  return (text) => {
    context.clearRect(0, 0, WIDTH, HEIGHT);
    context.fillText(text, 2, 3);
    const { data } = context.getImageData(0, 0, WIDTH, HEIGHT);
    let ink = 0;
    let own = 0; // pixels that are not the red they were asked to be drawn in
    let right = 0;
    let sum = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] < 24) continue;
      ink += 1;
      const x = (index / 4) % WIDTH;
      if (x > right) right = x;
      if (data[index + 1] > 40 || data[index + 2] > 40 || data[index] < 150) own += 1;
      // A cheap fingerprint of the shape, to tell two drawings apart.
      sum = (sum + (index / 4 + 1) * data[index + 3]) % 2147483647;
    }
    return { ink, own, right, sum };
  };
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The characters of `all` this system cannot draw, found out by drawing them. */
async function findMissing(all) {
  let probe = null;
  try {
    probe = createProbe();
  } catch {
    probe = null;
  }
  if (!probe) return [];
  const known = probe('😀');
  // No colour emoji at all (or a canvas that gives nothing away): no way to judge.
  if (!known.ink || !known.own) return [];
  // Two characters that do not exist: how this system draws what it does not know.
  const blank = probe('\u{3FFFD}');
  const other = probe('\u{2FFFD}');
  const sameBox = blank.ink > 0 && blank.sum === other.sum;
  const flags = Math.max(...all.map((item) => item.group));
  const missing = [];
  let slice = performance.now();
  for (const item of all) {
    // In short runs, so the page stays responsive while it happens.
    if (performance.now() - slice > 12) {
      await pause();
      slice = performance.now();
    }
    const drawn = probe(item.char);
    let fine = true;
    if (!drawn.ink) fine = false;
    // The parts of a combined emoji next to each other: twice as wide.
    else if (drawn.right > known.right * 1.4) fine = false;
    else if (!drawn.own) {
      // Drawn entirely in the given colour: a stand-in — unless it is one of
      // the plain symbols (＋ ✖ ♠) some systems draw in the colour of the text.
      if (item.group === flags) fine = false;
      else if (sameBox) fine = drawn.sum !== blank.sum;
      else fine = item.char.codePointAt(0) < 0x1f000;
    }
    if (!fine) missing.push(item.char);
  }
  return missing;
}

/**
 * The emoji of `all` that this system draws properly. When that cannot be
 * found out (no canvas), everything is kept.
 */
export async function supportedEmoji(all) {
  // Fonts come with the system and the browser: a new version asks again.
  const stamp = `${navigator.userAgent}|${all.length}`;
  const cached = storageGet(CACHE_KEY, null);
  let missing = cached?.stamp === stamp && Array.isArray(cached.missing) ? cached.missing : null;
  if (!missing) {
    missing = await findMissing(all);
    storageSet(CACHE_KEY, { stamp, missing });
  }
  if (!missing.length) return all;
  const gone = new Set(missing);
  return all.filter((item) => !gone.has(item.char));
}
