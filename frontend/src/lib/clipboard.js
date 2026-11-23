// Copying to the clipboard, including on plain-HTTP sites.
//
// navigator.clipboard only exists in secure contexts (HTTPS or localhost).
// A self-hosted instance is often opened as http://192.168.x.x, so there is a
// fallback that copies through a temporary, selected element.

function legacyCopy(text, html) {
  let ok = false;
  const onCopy = (event) => {
    event.clipboardData.setData('text/plain', text);
    if (html) event.clipboardData.setData('text/html', html);
    event.preventDefault();
    ok = true;
  };
  const holder = document.createElement('textarea');
  holder.value = text;
  holder.setAttribute('readonly', '');
  holder.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  const previous = document.activeElement;
  document.body.append(holder);
  holder.select();
  document.addEventListener('copy', onCopy, true);
  try {
    ok = document.execCommand('copy') && ok;
  } catch {
    ok = false;
  } finally {
    document.removeEventListener('copy', onCopy, true);
    holder.remove();
    if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
  }
  return ok;
}

/** Copy plain text (and optionally an HTML version). Resolves to true on success. */
export async function copyText(text, html = null) {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      if (html && window.ClipboardItem) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([text], { type: 'text/plain' }),
            'text/html': new Blob([html], { type: 'text/html' }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      return true;
    } catch {
      // Permission denied or document not focused: try the other way.
    }
  }
  return legacyCopy(text, html);
}
