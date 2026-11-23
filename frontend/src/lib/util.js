import { formatInstant } from './bgcalendar.js';

export function debounce(fn, wait, { maxWait } = {}) {
  let timer = null;
  let firstCall = 0;
  let lastArgs;
  const run = () => {
    clearTimeout(timer);
    timer = null;
    firstCall = 0;
    fn(...lastArgs);
  };
  const debounced = (...args) => {
    lastArgs = args;
    const now = Date.now();
    if (!firstCall) firstCall = now;
    clearTimeout(timer);
    const remaining = maxWait ? Math.max(0, maxWait - (now - firstCall)) : wait;
    timer = setTimeout(run, Math.min(wait, remaining));
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
    firstCall = 0;
  };
  debounced.flush = () => {
    if (timer) run();
  };
  debounced.pending = () => timer !== null;
  return debounced;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function timeAgo(iso) {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), 'hour');
  if (abs < 86400 * 7) return relative.format(Math.round(seconds / 86400), 'day');
  return formatDate(iso);
}

/** A timestamp from the server as "DD.MM.YYYY" or "DD.MM.YYYY HH:MM" (time in Sofia). */
export function formatDate(iso, withTime = false) {
  return formatInstant(iso, { time: withTime });
}

export function fileExtension(name) {
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index + 1).toLowerCase() : '';
}

export function initials(name) {
  const words = (name || '?').trim().split(/\s+/);
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}

export function storageGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function storageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be unavailable (private mode, quota); preferences are optional.
  }
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
