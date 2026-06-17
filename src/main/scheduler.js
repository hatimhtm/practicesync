'use strict';

/**
 * Lightweight in-process scheduler.
 *
 * Runs the provided task on a fixed interval ('6h' or 'daily'). Kept simple and
 * self-contained for the demo. For a production background agent we'd graduate
 * this to a macOS launchd job so it runs even when the window is closed, but the
 * interface here (start/stop/runNow/status) stays the same.
 */

const INTERVALS = {
  '6h': 6 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
};

class Scheduler {
  constructor() {
    this._timer = null;
    this._mode = 'off';
    this._task = null;
    this._running = false;
    this._onStatus = () => {};
  }

  configure({ task, onStatus }) {
    this._task = task;
    if (onStatus) this._onStatus = onStatus;
  }

  setMode(mode) {
    this._mode = mode;
    this._clear();
    const ms = INTERVALS[mode];
    if (ms) {
      // NOTE: this fires while the app is running (it stays alive in the menu
      // bar). Reboot/quit survival is handled at the app layer via a login item
      // + a catch-up run on launch (see main.js). We intentionally do NOT call
      // unref() here, so the timer reliably keeps the event loop alive.
      this._timer = setInterval(() => this.runNow('schedule'), ms);
    }
  }

  _clear() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  get mode() {
    return this._mode;
  }

  get isRunning() {
    return this._running;
  }

  async runNow(trigger = 'manual') {
    if (this._running || !this._task) {
      return { ok: false, error: this._running ? 'A run is already in progress.' : 'No task configured.' };
    }
    this._running = true;
    this._onStatus({ phase: 'running', trigger });
    try {
      const result = await this._task(trigger);
      this._onStatus({ phase: 'done', trigger, result });
      return result;
    } catch (err) {
      const error = err && err.message ? err.message : String(err);
      this._onStatus({ phase: 'error', trigger, error });
      return { ok: false, error };
    } finally {
      this._running = false;
    }
  }
}

module.exports = { Scheduler, INTERVALS };
