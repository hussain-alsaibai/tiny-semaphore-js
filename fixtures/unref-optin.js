'use strict';
// Child process for the "unrefTimeouts opt-in" regression test.
//
// With unrefTimeouts: true the timeout timer is unref'd, so it does NOT
// keep the event loop alive. If nothing else is pending, Node exits before
// the timeout fires and the acquire() promise never settles.
//
// That is the documented behaviour of the opt-in, so this script is expected
// to print NOTHING and exit 0.

const { Semaphore } = require('../semaphore');

const sem = new Semaphore({ permits: 1, unrefTimeouts: true });

(async () => {
  const release = await sem.acquire();
  const started = Date.now();
  try {
    await sem.acquire(1, 50);
    console.log('RESOLVED unexpectedly');
  } catch (err) {
    console.log('REJECTED after ' + (Date.now() - started) + 'ms ' + err.code);
  }
  release();
})();
