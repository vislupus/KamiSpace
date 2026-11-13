// Autosave with optimistic concurrency.
//
//   saved ──edit──▶ dirty ──(debounce)──▶ saving ──ok──▶ saved
//                                            │
//                         network error ◀────┼────▶ 409 conflict (waits for the user)
//                         (retries with backoff)
//
// The server only accepts a save whose base revision matches, so a stale tab
// can never silently overwrite newer content.
import { api } from '../lib/api.js';
import { debounce } from '../lib/util.js';

const SAVE_DELAY = 800;
const MAX_DELAY = 5000;
const RETRY_STEPS = [2000, 4000, 8000, 15000, 30000];

export class DocSaver {
  constructor({ pageId, revision, getContent, onState }) {
    this.pageId = pageId;
    this.revision = revision;
    this.getContent = getContent;
    this.onState = onState;
    this.state = 'saved';
    this.dirty = false;
    this.saving = null;
    this.conflict = null;
    this.retries = 0;
    this.retryTimer = null;
    this.destroyed = false;
    this.schedule = debounce(() => this.save(), SAVE_DELAY, { maxWait: MAX_DELAY });
    this.onOnline = () => {
      if (this.state === 'offline') this.save();
    };
    window.addEventListener('online', this.onOnline);
  }

  setState(state, detail = null) {
    this.state = state;
    if (!this.destroyed) this.onState(state, detail);
  }

  /** Call after every document change. */
  touch() {
    this.dirty = true;
    if (this.conflict) return; // wait for the user to resolve the conflict
    if (this.state !== 'saving' && this.state !== 'offline') this.setState('dirty');
    this.schedule();
  }

  hasUnsavedChanges() {
    return this.dirty || this.saving !== null;
  }

  /** Save now (used when leaving the page). Resolves when the attempt is over. */
  async flush() {
    this.schedule.cancel();
    if (this.saving) await this.saving;
    if (this.dirty && !this.conflict) await this.save();
  }

  save({ force = false } = {}) {
    if (this.saving) return this.saving;
    if (!this.dirty && !force) return Promise.resolve();
    if (this.conflict && !force) return Promise.resolve();
    clearTimeout(this.retryTimer);
    this.schedule.cancel();
    this.saving = this.performSave(force).finally(() => {
      this.saving = null;
      // Edits made while the request was in flight.
      if (this.dirty && this.state === 'dirty' && !this.destroyed) this.schedule();
    });
    return this.saving;
  }

  async performSave(force) {
    this.dirty = false;
    this.setState('saving');
    try {
      const result = await api.put(`/api/pages/${this.pageId}/content`, {
        content: this.getContent(),
        base_revision: this.revision,
        force,
      });
      this.revision = result.revision;
      this.conflict = null;
      this.retries = 0;
      this.setState(this.dirty ? 'dirty' : 'saved');
    } catch (error) {
      this.dirty = true;
      if (error.status === 409) {
        this.conflict = error.data;
        this.setState('conflict', error.data);
      } else if (error.isNetwork || error.status >= 500) {
        this.setState('offline');
        const delay = RETRY_STEPS[Math.min(this.retries, RETRY_STEPS.length - 1)];
        this.retries += 1;
        this.retryTimer = setTimeout(() => this.save(), delay);
      } else {
        // Not retryable (no permission any more, page deleted, too large…).
        this.setState('error', error.message);
      }
    }
  }

  /** The user chose to keep their version: overwrite, the other one stays in history. */
  overwrite() {
    if (!this.conflict) return Promise.resolve();
    this.revision = this.conflict.current_revision ?? this.revision;
    return this.save({ force: true });
  }

  /** Content was replaced from the server (reload after conflict, refresh). */
  reset(revision) {
    this.revision = revision;
    this.dirty = false;
    this.conflict = null;
    this.schedule.cancel();
    clearTimeout(this.retryTimer);
    this.setState('saved');
  }

  destroy() {
    this.destroyed = true;
    this.schedule.cancel();
    clearTimeout(this.retryTimer);
    window.removeEventListener('online', this.onOnline);
  }
}
