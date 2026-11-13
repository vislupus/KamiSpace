// Which pages are expanded in the sidebar (remembered per browser).
import { storageGet, storageSet } from '../lib/util.js';

const KEY = 'minddock.expanded';
const expanded = new Set(storageGet(KEY, []));

function persist() {
  storageSet(KEY, [...expanded].slice(-500));
}

export function isExpanded(id) {
  return expanded.has(id);
}

export function setExpanded(id, value) {
  if (value) expanded.add(id);
  else expanded.delete(id);
  persist();
}

export function expandAll(ids) {
  let changed = false;
  for (const id of ids) {
    if (!expanded.has(id)) {
      expanded.add(id);
      changed = true;
    }
  }
  if (changed) persist();
  return changed;
}
