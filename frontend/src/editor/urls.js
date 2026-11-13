// URL rules shared by the link editor and the Link extension. They mirror the
// server-side allow-list in app/services/document.py.
const SAFE_URL = /^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i;

export function isSafeUrl(url) {
  if (typeof url !== 'string' || url.length > 2048) return false;
  // Browsers ignore whitespace and control characters inside a scheme.
  // eslint-disable-next-line no-control-regex
  return SAFE_URL.test(url.replace(/[\u0000-\u001f\u007f\s]+/g, ''));
}

/** Turn what a person typed into a safe absolute URL, or null. */
export function normalizeUrl(input) {
  const value = (input ?? '').trim();
  if (!value) return null;
  if (isSafeUrl(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null; // some other scheme
  if (/\s/.test(value)) return null;
  if (/^[^@/]+@[^@/]+\.[^@/]+$/.test(value)) return `mailto:${value}`;
  if (/^[^/]+\.[^/]+/.test(value) || value.startsWith('localhost')) return `https://${value}`;
  return null;
}
