'use strict';

/**
 * @file tiny-semaphore — bounded async concurrency control with weighted permits.
 *
 * Limits how many async operations run concurrently. Useful for AI agents
 * that spawn many parallel API calls and need to stay under rate limits.
 *
 * Three usage styles:
 *
 *   // Manual acquire/release (with RAII-style release closure)
 *   const release = await sem.acquire(2);
 *   try { await work(); } finally { release(); }
 *
 *   // Convenience wrapper
 *   const result = await sem.run(() => work(), 2);
 *
 *   // Scoped critical section
 *   await sem.withLock(async () => {
 *     await work();
 *   }, 1);
 *
 * Acquirers are served FIFO when permits are scarce; a per-acquirer
 * permit count lets a single caller reserve >1 slot atomically.
 */

const VERSION = '0.1.0';

/**
 * Thrown when `acquire()` cannot be satisfied within the requested timeout.
 *
 * @extends Error
 */
class SemaphoreTimeoutError extends Error {
  /**
   * @param {number} permits - the number of permits that could not be acquired
   * @param {number} timeoutMs - the timeout that elapsed
   */
  constructor(permits, timeoutMs) {
    super(
      `Semaphore: could not acquire ${permits} permit(s) within ${timeoutMs}ms`
    );
    this.name = 'SemaphoreTimeoutError';
    this.code = 'SEMAPHORE_TIMEOUT';
    this.permits = permits;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Snapshot of current semaphore state. Cheap to read.
 */
class SemaphoreStats {
  /**
   * @param {object} s
   * @param {number} s.limit - configured max permits
   * @param {number} s.active - permits currently held
   * @param {number} s.waiters - tasks currently waiting
   * @param {number} s.totalAcquired - lifetime acquire count (post-success only)
   * @param {number} s.totalReleased - lifetime release count
   * @param {number} s.totalTimeouts - lifetime timeouts
   */
  constructor(s) {
    this.limit = s.limit;
    this.active = s.active;
    this.waiters = s.waiters;
    this.available = s.limit - s.active;
    this.totalAcquired = s.totalAcquired;
    this.totalReleased = s.totalReleased;
    this.totalTimeouts = s.totalTimeouts;
  }
}

/**
 * Lightweight event emitter. Used for acquire/release/timeout events so
 * callers can plug observability in without leaking internal state.
 *
 * Listeners are called synchronously; failures are swallowed so a buggy
 * observer cannot break the semaphore. For tests we want a tiny surface,
 * so this is hand-rolled instead of pulling in `events`.
 */
class _Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {Function} listener
   * @returns {() => void} unsubscribe function
   */
  on(event, listener) {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  /**
   * @private
   * @param {string} event
   * @param  {...any} args
   */
  _emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(...args);
      } catch {
        /* swallow listener errors */
      }
    }
  }
}

/**
 * Weighted async semaphore.
 *
 * @fires Semaphore#acquire when a caller acquires permits (after they are granted)
 * @fires Semaphore#release when a caller releases permits
 * @fires Semaphore#timeout when an acquire times out
 */
class Semaphore extends _Emitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.permits=1] - max permits (a.k.a. "concurrency slots")
   * @param {number} [opts.maxQueueSize=Infinity] - cap on waiting tasks; new acquires throw `Error` past the limit
   * @param {boolean} [opts.fairness=true] - if true, waiting acquirers are served FIFO
   */
  constructor(opts = {}) {
    super();
    const permits = opts.permits ?? 1;
    if (!Number.isInteger(permits) || permits < 1) {
      throw new RangeError(
        `Semaphore: permits must be a positive integer (got ${permits})`
      );
    }
    if (
      opts.maxQueueSize !== undefined &&
      (!Number.isFinite(opts.maxQueueSize) ||
        !Number.isInteger(opts.maxQueueSize) ||
        opts.maxQueueSize < 0)
    ) {
      throw new RangeError(
        `Semaphore: maxQueueSize must be a non-negative integer (got ${opts.maxQueueSize})`
      );
    }

    /** @type {number} max permits */
    this._limit = permits;
    /** @type {number} currently available permits */
    this._active = 0;
    /** @type {number} */
    this._maxQueueSize = opts.maxQueueSize ?? Infinity;
    /** @type {boolean} */
    this._fairness = opts.fairness !== false;

    /**
     * FIFO waiters. Each entry: { permits, resolve, reject, timer, startedAt }
     * @type {Array<{permits:number,resolve:Function,reject:Function,timer:any,startedAt:number}>}
     */
    this._waiters = [];

    /** lifetime counters (debug/observability) */
    this._totalAcquired = 0;
    this._totalReleased = 0;
    this._totalTimeouts = 0;

    this.version = VERSION;
  }

  /** @returns {number} configured permit limit */
  get limit() {
    return this._limit;
  }

  /** @returns {number} currently held permits */
  get active() {
    return this._active;
  }

  /** @returns {number} available permits */
  get available() {
    return this._limit - this._active;
  }

  /** @returns {number} current FIFO queue length */
  get waiters() {
    return this._waiters.length;
  }

  /** @returns {boolean} whether FIFO ordering is enforced */
  get fairness() {
    return this._fairness;
  }

  /**
   * Snapshot current state.
   * @returns {SemaphoreStats}
   */
  stats() {
    return new SemaphoreStats({
      limit: this._limit,
      active: this._active,
      waiters: this._waiters.length,
      totalAcquired: this._totalAcquired,
      totalReleased: this._totalReleased,
      totalTimeouts: this._totalTimeouts,
    });
  }

  /**
   * Try to acquire permits immediately without waiting.
   *
   * @param {number} [permits=1] - number of permits to acquire; must be an integer in [1, limit]
   * @returns {null | () => void} release function on success, `null` if not enough permits are free
   */
  tryAcquire(permits = 1) {
    this._validatePermits(permits);
    if (this._active + permits > this._limit) return null;
    this._active += permits;
    this._totalAcquired++;
    this._emit('acquire', permits);
    return () => this.release(permits);
  }

  /**
   * Acquire permits. Resolves when granted. Throws `SemaphoreTimeoutError`
   * if the timeout elapses first.
   *
   * If the underlying timer fires after we successfully acquired the slot
   * (race), the timer is cancelled and the caller still gets a valid release.
   *
   * @param {number} [permits=1]
   * @param {number} [timeout] - ms; undefined = wait forever
   * @returns {Promise<() => void>} async release function (RAII-style)
   */
  acquire(permits = 1, timeout) {
    this._validatePermits(permits);

    // Try to satisfy immediately. This lets the common case skip the queue
    // entirely (no microtask cost beyond the promise resolution).
    if (this._waiters.length === 0 && this._active + permits <= this._limit) {
      this._active += permits;
      this._totalAcquired++;
      this._emit('acquire', permits);
      return Promise.resolve(this._makeRelease(permits));
    }

    // Queue overflow check — happens before we queue so a slow caller
    // can't behead the queue via timeout.
    if (this._waiters.length >= this._maxQueueSize) {
      return Promise.reject(
        new RangeError(
          `Semaphore: queue full (${this._waiters.length}/${this._maxQueueSize})`
        )
      );
    }

    return new Promise((resolve, reject) => {
      const entry = { permits, resolve, reject, timer: null, startedAt: Date.now() };

      if (this._fairness) {
        this._waiters.push(entry);
      } else {
        // Non-fair mode: insert before any waiter that asked for more than
        // we can fit sooner. This is a best-effort greedy policy — not as
        // accurate as a true LIFO with priority, but it avoids head-of-line
        // blocking when a big weight request lands.
        let i = this._waiters.length;
        while (i > 0 && this._waiters[i - 1].permits >= permits) i--;
        this._waiters.splice(i, 0, entry);
      }

      if (timeout !== undefined && timeout !== Infinity && timeout > 0) {
        entry.timer = setTimeout(() => this._handleTimeout(entry), timeout);
        // Don't keep the event loop alive just to fire a timeout.
        if (typeof entry.timer.unref === 'function') entry.timer.unref();
      } else if (timeout === 0) {
        // timeout=0 = poll once; if can't satisfy now, throw.
        // Remove ourselves from the queue and reject.
        this._removeWaiter(entry);
        reject(new SemaphoreTimeoutError(permits, 0));
        this._totalTimeouts++;
        this._emit('timeout', permits, 0);
      }
    });
  }

  /**
   * Acquire + auto-release on completion or error.
   *
   * Equivalent to `try { release = await acquire(); return await fn(); } finally { release(); }`.
   *
   * @template T
   * @param {() => Promise<T> | T} fn
   * @param {number} [permits=1]
   * @param {number} [timeout] - ms; throws `SemaphoreTimeoutError` if not acquired in time
   * @returns {Promise<T>}
   */
  async run(fn, permits = 1, timeout) {
    const release = await this.acquire(permits, timeout);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Scoped RAII-style critical section. Sugar over `run()`.
   *
   * @template T
   * @param {() => Promise<T> | T} fn
   * @param {number} [permits=1]
   * @param {number} [timeout] - ms
   * @returns {Promise<T>}
   */
  withLock(fn, permits = 1, timeout) {
    return this.run(fn, permits, timeout);
  }

  /**
   * Release `permits` slots. Wakes as many waiters as can fit.
   *
   * Safe to over-release (clamps to `limit`) — protects against bugs in
   * caller code that would otherwise let `_active` go negative.
   *
   * @param {number} [permits=1]
   */
  release(permits = 1) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new RangeError(
        `Semaphore.release: permits must be a positive integer (got ${permits})`
      );
    }
    this._active = Math.max(0, this._active - permits);
    this._totalReleased++;
    this._emit('release', permits);
    this._drainQueue();
  }

  /**
   * Run many async tasks under bounded concurrency.
   *
   * @template T
   * @param {Array<() => Promise<T>>} tasks
   * @param {object} [opts]
   * @param {number} [opts.permits=1] - weight per task
   * @param {number} [opts.timeout] - per-task acquire timeout
   * @returns {Promise<T[]>} results in input order
   */
  async gather(tasks, opts = {}) {
    const weight = opts.permits ?? 1;
    return Promise.all(
      tasks.map((task) => this.run(task, weight, opts.timeout))
    );
  }

  /**
   * Drain the waiter queue, granting permits as room allows.
   * @private
   */
  _drainQueue() {
    // FIFO mode requires strict head-of-line service.
    // Non-fair mode lets us pick any waiter whose weight fits.
    if (this._fairness) {
      while (this._waiters.length > 0 && this._waiters[0].permits <= this.available) {
        const next = this._waiters.shift();
        this._grant(next);
      }
    } else {
      // Greedy fit: keep trying to satisfy the most-fitting waiter.
      let progress = true;
      while (progress) {
        progress = false;
        for (let i = 0; i < this._waiters.length; i++) {
          if (this._waiters[i].permits <= this.available) {
            const [next] = this._waiters.splice(i, 1);
            this._grant(next);
            progress = true;
            break; // restart scan after state change
          }
        }
      }
    }
  }

  /**
   * @private
   * @param {{permits:number,resolve:Function,reject:Function,timer:any}} entry
   */
  _grant(entry) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    this._active += entry.permits;
    this._totalAcquired++;
    this._emit('acquire', entry.permits);
    entry.resolve(this._makeRelease(entry.permits));
  }

  /**
   * @private
   * @param {{permits:number,resolve:Function,reject:Function,timer:any}} entry
   */
  _handleTimeout(entry) {
    if (!this._removeWaiter(entry)) return; // already granted
    this._totalTimeouts++;
    this._emit('timeout', entry.permits);
    entry.reject(new SemaphoreTimeoutError(entry.permits, _elapsedMs(entry)));
  }

  /**
   * @private
   * @param {object} entry
   * @returns {boolean} true if removed
   */
  _removeWaiter(entry) {
    const i = this._waiters.indexOf(entry);
    if (i < 0) return false;
    this._waiters.splice(i, 1);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    return true;
  }

  /**
   * @private
   * @param {number} permits
   */
  _makeRelease(permits) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(permits);
    };
  }

  /**
   * @private
   * @param {number} permits
   */
  _validatePermits(permits) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new RangeError(
        `Semaphore: permits must be a positive integer (got ${permits})`
      );
    }
    if (permits > this._limit) {
      throw new RangeError(
        `Semaphore: requested ${permits} permits exceeds limit ${this._limit}`
      );
    }
  }
}

/**
 * @param {{startedAt:number}} entry
 * @returns {number}
 * @private
 */
function _elapsedMs(entry) {
  return Date.now() - entry.startedAt;
}

module.exports = { Semaphore, SemaphoreTimeoutError, SemaphoreStats, VERSION };
