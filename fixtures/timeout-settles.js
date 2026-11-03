'use strict';
// Child process for the "timeout settles on its own" regression test.
// Deliberately keeps NOTHING pending: no interval, no other timer.
// If the semaphore's timeout timer is unref'd, Node exits here with the
// acquire() promise still unresolved and this script prints nothing.

const { Semaphore } = require('../semaphore');

const sem = new Semaphore({ permits: 1 });

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
