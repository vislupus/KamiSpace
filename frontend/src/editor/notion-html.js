// Making pasted HTML fit the editor — above all what Notion puts on the
// clipboard. Notion turns the copied blocks into Markdown and that into
// HTML, so some blocks arrive as look-alikes:
//
//   to-do items    <ul><li>[ ] text</li><li>[x] done</li></ul>
//   toggles        <details><summary>Title</summary>…the blocks inside…</details>
//   callouts       <aside>💡 text</aside>
//
// They are rewritten here into the HTML the editor's own blocks are read
// from. Check boxes written other ways (GitHub's <input type="checkbox">,
// Notion's export with <div class="checkbox">) are understood as well.

const BOX = /^\s*\[( |x|X)?\]\s+/;
const EMOJI = /^\s*((?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator})*)\s*/u;

/** The first piece of text of an element that is its own (not of a nested list). */
function firstText(element) {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue.trim()) continue;
    const list = node.parentElement.closest('ul, ol');
    return list && element.contains(list) && list !== element.parentElement ? null : node;
  }
  return null;
}

/** Is this list item a to-do? null (no), false (open) or true (done). The marker is removed. */
function takeCheckbox(item) {
  const box = item.querySelector(
    ':scope > input[type="checkbox"], :scope > p:first-child > input[type="checkbox"], :scope > label > input[type="checkbox"], :scope > div.checkbox, :scope > span.checkbox',
  );
  if (box) {
    const checked = box.tagName === 'INPUT' ? box.hasAttribute('checked') || box.checked : box.classList.contains('checkbox-on');
    box.remove();
    return checked;
  }
  const text = firstText(item);
  const match = text ? BOX.exec(text.nodeValue) : null;
  if (!match) return null;
  text.nodeValue = text.nodeValue.slice(match[0].length);
  return match[1] === 'x' || match[1] === 'X';
}

/** Runs of to-do items become task lists; the other items stay in lists of their own kind. */
function convertTaskItems(list) {
  const items = [...list.children].filter((child) => child.tagName === 'LI');
  const states = items.map(takeCheckbox);
  if (!states.some((state) => state !== null)) return false;
  const doc = list.ownerDocument;
  let run = null;
  let runIsTasks = null;
  items.forEach((item, index) => {
    const isTask = states[index] !== null;
    if (run === null || isTask !== runIsTasks) {
      run = doc.createElement(isTask ? 'ul' : list.tagName.toLowerCase());
      if (isTask) run.setAttribute('data-type', 'taskList');
      runIsTasks = isTask;
      list.before(run);
    }
    if (isTask) {
      item.setAttribute('data-type', 'taskItem');
      item.setAttribute('data-checked', String(states[index]));
    }
    run.append(item);
  });
  list.remove();
  return true;
}

function convertToggle(details) {
  const doc = details.ownerDocument;
  let summary = details.querySelector(':scope > summary');
  if (!summary) {
    summary = doc.createElement('summary');
    details.prepend(summary);
  }
  // A toggle heading: the heading is the summary line.
  const heading = summary.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4');
  if (heading && summary.textContent.trim() === heading.textContent.trim()) {
    details.setAttribute('data-level', String(Math.min(Number(heading.tagName[1]), 3)));
    heading.replaceWith(...heading.childNodes);
  }
  if (!details.querySelector(':scope > div[data-type="detailsContent"]')) {
    const body = doc.createElement('div');
    body.setAttribute('data-type', 'detailsContent');
    for (const child of [...details.childNodes]) {
      if (child !== summary) body.append(child);
    }
    details.append(body);
  }
  // What was copied is shown, not folded away.
  details.setAttribute('open', '');
}

function convertCallout(aside) {
  const doc = aside.ownerDocument;
  const callout = doc.createElement('div');
  callout.setAttribute('data-callout', '');
  callout.setAttribute('data-variant', 'note');
  const text = firstText(aside);
  const icon = text ? EMOJI.exec(text.nodeValue) : null;
  if (icon) {
    callout.setAttribute('data-emoji', icon[1]);
    text.nodeValue = text.nodeValue.slice(icon[0].length);
  }
  callout.append(...aside.childNodes);
  aside.replaceWith(callout);
}

/**
 * The HTML as the editor should read it. Returned unchanged (the very same
 * string) when there is nothing in it to rewrite.
 */
export function normalizePastedHtml(html) {
  if (!/<(li|details|aside)\b/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let changed = false;
  // Innermost lists first, so that a list is settled before the item around it is moved.
  for (const list of [...doc.querySelectorAll('ul, ol')].reverse()) {
    if (list.getAttribute('data-type') === 'taskList') continue;
    changed = convertTaskItems(list) || changed;
  }
  for (const details of [...doc.querySelectorAll('details')].reverse()) {
    convertToggle(details);
    changed = true;
  }
  for (const aside of [...doc.querySelectorAll('aside')].reverse()) {
    convertCallout(aside);
    changed = true;
  }
  return changed ? doc.body.innerHTML : html;
}
