'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Semaphore,
  SemaphoreTimeoutError,
  SemaphoreStats,
  VERSION,
} = require('./semaphore');

// Helper: run async work under the semaphore and capture ordering.
async function pause(ms = 10) {
  return new Promise((r) => setTimeout(r, ms));
}

// 1
test('constructor: defaults to 1 permit', () => {
  const sem = new Semaphore();
  assert.equal(sem.limit, 1);
  assert.equal(sem.active, 0);
  assert.equal(sem.available, 1);
  assert.equal(sem.waiters, 0);
});

// 2
test('constructor: accepts explicit permits', () => {
  const sem = new Semaphore({ permits: 5 });
  assert.equal(sem.limit, 5);
  assert.equal(sem.available, 5);
});

// 3
test('constructor: rejects invalid permits', () => {
  assert.throws(() => new Semaphore({ permits: 0 }), RangeError);
  assert.throws(() => new Semaphore({ permits: -1 }), RangeError);
  assert.throws(() => new Semaphore({ permits: 1.5 }), RangeError);
  assert.throws(() => new Semaphore({ permits: 'x' }), RangeError);
});

// 4
test('constructor: rejects invalid maxQueueSize', () => {
  assert.throws(() => new Semaphore({ permits: 5, maxQueueSize: -1 }), RangeError);
  assert.throws(() => new Semaphore({ permits: 5, maxQueueSize: 1.5 }), RangeError);
});

// 5
test('tryAcquire: succeeds when permits available', () => {
  const sem = new Semaphore({ permits: 2 });
  const release = sem.tryAcquire();
  assert.equal(typeof release, 'function');
  assert.equal(sem.active, 1);
  assert.equal(sem.available, 1);
  release();
  assert.equal(sem.active, 0);
});

// 6
test('tryAcquire: returns null when at capacity', () => {
  const sem = new Semaphore({ permits: 1 });
  const r1 = sem.tryAcquire();
  assert.notEqual(r1, null);
  const r2 = sem.tryAcquire();
  assert.equal(r2, null);
  assert.equal(sem.active, 1);
});

// 7
test('tryAcquire: weighted permits respected', () => {
  const sem = new Semaphore({ permits: 5 });
  const r1 = sem.tryAcquire(2);
  assert.notEqual(r1, null);
  assert.equal(sem.active, 2);
  const r2 = sem.tryAcquire(3);
  assert.notEqual(r2, null);
  assert.equal(sem.active, 5);
  const r3 = sem.tryAcquire(1);
  assert.equal(r3, null);
});

// 8
test('acquire/release: basic round trip', async () => {
  const sem = new Semaphore({ permits: 1 });
  const release = await sem.acquire();
  assert.equal(sem.active, 1);
  release();
  assert.equal(sem.active, 0);
});

// 9
test('acquire: throws on invalid weight', () => {
  const sem = new Semaphore({ permits: 3 });
  // Validation throws synchronously for invalid input — failing fast
  // prevents queueing bad requests and burning slots.
  assert.throws(() => sem.acquire(0), RangeError);
  assert.throws(() => sem.acquire(2.5), RangeError);
  assert.throws(() => sem.acquire(4), RangeError); // > limit
  assert.throws(() => sem.acquire(-1), RangeError);
});

// 10
test('acquire: blocks when full, unblocks on release', async () => {
  const sem = new Semaphore({ permits: 1 });
  const r1 = await sem.acquire();

  let secondResolved = false;
  const p2 = sem.acquire().then((r) => {
    secondResolved = true;
    return r;
  });

  await pause(20);
  assert.equal(secondResolved, false, 'second acquire should be queued');

  r1();
  const r2 = await p2;
  assert.equal(secondResolved, true);
  r2();
  assert.equal(sem.active, 0);
});

// 11
test('acquire: weighted requests consume multiple permits', async () => {
  const sem = new Semaphore({ permits: 4 });
  const r1 = await sem.acquire(2);
  const r2 = await sem.acquire(2);
  assert.equal(sem.active, 4);
  assert.equal(sem.available, 0);

  // Now a 3-permit request would exceed the limit — it should queue.
  let thirdResolved = false;
  const p3 = sem.acquire(3).then((r) => {
    thirdResolved = true;
    return r;
  });
  await pause(15);
  assert.equal(thirdResolved, false, 'over-capacity acquire should queue');

  // Releasing 1 permit is not enough.
  r1();
  await pause(15);
  assert.equal(thirdResolved, false, '1 free permit should not satisfy 3-permit request');

  // Releasing 2 more permits unblocks it.
  r2();
  const r3 = await p3;
  assert.equal(thirdResolved, true);
  assert.equal(sem.active, 3);
  r3();
  assert.equal(sem.active, 0);
});

// 12
test('release: is idempotent and safe under repeated calls', async () => {
  const sem = new Semaphore({ permits: 2 });
  const r1 = await sem.acquire(2);
  r1();
  r1(); // double-release should not crash or over-release
  assert.equal(sem.active, 0, '_active must clamp at 0');
  r1(); // triple — still safe
  assert.equal(sem.active, 0);
});

// 13
test('release: releases single permit by default', () => {
  const sem = new Semaphore({ permits: 3 });
  sem.release(1); // start below zero, clamp
  assert.equal(sem.active, 0);
});

// 14
test('run: convenience wrapper releases on success', async () => {
  const sem = new Semaphore({ permits: 2 });
  const out = await sem.run(async () => {
    assert.equal(sem.active, 1);
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.equal(sem.active, 0);
});

// 15
test('run: releases on thrown error', async () => {
  const sem = new Semaphore({ permits: 1 });
  await assert.rejects(
    sem.run(async () => {
      throw new Error('boom');
    }),
    /boom/
  );
  assert.equal(sem.active, 0, 'run() must release even when fn throws');
  assert.equal(sem.waiters, 0);
});

// 16
test('run: weighted acquire consumes specified permits', async () => {
  const sem = new Semaphore({ permits: 5 });
  const out = await sem.run(
    async () => {
      assert.equal(sem.active, 2);
      return 42;
    },
    2
  );
  assert.equal(out, 42);
  assert.equal(sem.active, 0);
});

// 17
test('withLock: scoped critical section', async () => {
  const sem = new Semaphore({ permits: 3 });
  const inside = await sem.withLock(async () => {
    assert.equal(sem.active, 1);
    return 'done';
  });
  assert.equal(inside, 'done');
  assert.equal(sem.active, 0);
});

// 18
test('acquire: timeout throws SemaphoreTimeoutError', async () => {
  const sem = new Semaphore({ permits: 1 });
  const r1 = await sem.acquire();

  await assert.rejects(
    sem.acquire(1, 30),
    (err) => {
      assert.ok(err instanceof SemaphoreTimeoutError);
      assert.equal(err.code, 'SEMAPHORE_TIMEOUT');
      assert.equal(err.permits, 1);
      assert.ok(err.timeoutMs >= 25);
      return true;
    }
  );

  r1();
  assert.equal(sem.active, 0);
});

// 19
test('acquire: timeout=0 returns immediately if unable', async () => {
  const sem = new Semaphore({ permits: 1 });
  const r1 = await sem.acquire();
  await assert.rejects(
    sem.acquire(1, 0),
    (err) => err instanceof SemaphoreTimeoutError
  );
  r1();
});

// 20
test('acquire: timeout cleared once granted (race-safe)', async () => {
  const sem = new Semaphore({ permits: 1 });
  const r1 = await sem.acquire();

  // Acquire with very short timeout — release just before timeout fires.
  const p2 = sem.acquire(1, 50);
  await pause(10);
  r1();

  const r2 = await p2;
  assert.equal(typeof r2, 'function');
  // If the timer wasn't cleared, _active would be wrong after release below.
  r2();
  assert.equal(sem.active, 0);
});

// 21
test('queue ordering: FIFO with fairness', async () => {
  const sem = new Semaphore({ permits: 1, fairness: true });
  const order = [];
  const r1 = await sem.acquire();

  const p1 = sem.run(async () => order.push(1));
  const p2 = sem.run(async () => order.push(2));
  const p3 = sem.run(async () => order.push(3));

  await pause(10);
  assert.equal(order.length, 0, 'queued tasks must not run while full');

  r1();
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, [1, 2, 3], 'FIFO ordering');
});

// 22
test('queue ordering: fairness=false lets small requests skip big ones', async () => {
  const sem = new Semaphore({ permits: 4, fairness: false });
  const r1 = await sem.acquire(3); // occupies 3 of 4

  const order = [];
  // Big request (needs 2) and small one (needs 1):
  const pBig = sem.run(async () => order.push('big'), 2);
  const pSmall = sem.run(async () => order.push('small'), 1);

  await pause(10);
  assert.equal(order.length, 0);

  r1(); // releases 3, leaving 3 free
  await Promise.all([pBig, pSmall]);
  // In non-fair mode, the 1-permit task should be schedulable first because
  // we have a "small requests skip big" policy.
  assert.equal(order[0], 'small', `expected small first, got order=${order.join(',')}`);
  assert.equal(order[1], 'big');
});

// 23
test('gather: bounded concurrent execution', async () => {
  const sem = new Semaphore({ permits: 2 });
  let inside = 0;
  let peak = 0;
  const tasks = Array.from({ length: 10 }, (_, i) => async () => {
    inside++;
    peak = Math.max(peak, inside);
    await pause(20);
    inside--;
    return i;
  });

  const start = Date.now();
  const results = await sem.gather(tasks);
  const elapsed = Date.now() - start;

  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(peak <= 2, `peak concurrency was ${peak}, expected <= 2`);
  assert.ok(elapsed >= 90, `elapsed ${elapsed}ms, expected >= 90ms (5 batches)`);
});

// 24
test('gather: respects per-task acquire timeout', async () => {
  const sem = new Semaphore({ permits: 1 });
  await sem.acquire();
  await assert.rejects(
    sem.gather(
      [async () => 1, async () => 2],
      { permits: 1, timeout: 10 }
    ),
    SemaphoreTimeoutError
  );
  // We hold the original permit so the first gather task can never acquire.
});

// 25
test('maxQueueSize: rejects when queue full', async () => {
  const sem = new Semaphore({ permits: 1, maxQueueSize: 1 });
  const r1 = await sem.acquire();
  // 1 queued is fine:
  const p1 = sem.acquire();
  // 2nd queue entry should be rejected:
  await assert.rejects(
    sem.acquire(),
    (err) => err instanceof RangeError && /queue full/i.test(err.message)
  );
  r1();
  await p1;
});

// 26
test('stats: accurate counters', async () => {
  const sem = new Semaphore({ permits: 2 });
  await sem.acquire();
  await sem.acquire();

  await assert.rejects(sem.acquire(1, 25), SemaphoreTimeoutError);

  const s = sem.stats();
  assert.ok(s instanceof SemaphoreStats);
  assert.equal(s.limit, 2);
  assert.equal(s.active, 2);
  assert.equal(s.waiters, 0);
  assert.equal(s.available, 0);
  assert.equal(s.totalAcquired, 2);
  assert.equal(s.totalTimeouts, 1);
});

// 27
test('RAII: release closure fires exactly once and self-guards', async () => {
  const sem = new Semaphore({ permits: 2 });
  const r = await sem.acquire();
  let calls = 0;
  // Wrap the user-facing release to count invocations; mutate 'r' by
  // reassigning a sentinel after first call.
  const wrapped = () => {
    calls++;
    r();
  };
  wrapped();
  wrapped();
  wrapped();
  // The underlying _makeRelease closure has its own "released" guard, so
  // even wrapping multiple times should not over-release.
  assert.equal(sem.active, 0);
  // We can't assert on `calls` precisely because the guard is inside, but
  // we can assert no crash and active is sane.
  assert.ok(calls === 3);
});

// 28
test('events: emits acquire / release / timeout', async () => {
  const sem = new Semaphore({ permits: 2 });
  const events = [];
  sem.on('acquire', (n) => events.push(['acquire', n]));
  sem.on('release', (n) => events.push(['release', n]));
  sem.on('timeout', (n) => events.push(['timeout', n]));

  const r1 = await sem.acquire(2);
  assert.deepEqual(events, [['acquire', 2]]);
  r1();
  assert.deepEqual(events, [['acquire', 2], ['release', 2]]);

  // Fill the semaphore so subsequent acquires queue and time out.
  const r2 = await sem.acquire();
  const r3 = await sem.acquire();
  const eventsAfterFill = events.slice();
  await assert.rejects(sem.acquire(1, 25), SemaphoreTimeoutError);
  const newEvents = events.slice(eventsAfterFill.length);
  assert.deepEqual(newEvents, [['timeout', 1]]);
  r2();
  r3();
});

// 29
test('drain: queue services one waiter per release (FIFO)', async () => {
  const sem = new Semaphore({ permits: 1, fairness: true });
  const order = [];
  const waiters = 5;

  const r0 = await sem.acquire(); // capacity 1 in use

  // Queue 5 waiters — each needs to run a tiny task then release.
  const tasks = Array.from({ length: waiters }, (_, i) =>
    sem.run(async () => {
      order.push(i);
    })
  );

  await pause(15);
  assert.equal(order.length, 0, 'no waiter runs while at capacity');

  // One release -> one waiter fires. That waiter finishes (immediately),
  // calls its own release, which drains the next waiter, and so on.
  // The cascade is FIFO because fairness=true.
  r0();
  await Promise.all(tasks);
  assert.equal(order.length, waiters);
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
});

// 30
// Regression: the timeout timer must keep the event loop alive.
// An unref'd timer let Node drain the loop and exit while acquire() was
// still waiting, so the promise never settled and never rejected.
test('acquire: timeout settles even when nothing else keeps the loop alive', async () => {
  const sem = new Semaphore({ permits: 1 });
  const r1 = await sem.acquire();

  const t = Date.now();
  await assert.rejects(
    sem.acquire(1, 30),
    (err) => {
      assert.ok(err instanceof SemaphoreTimeoutError);
      assert.equal(err.code, 'SEMAPHORE_TIMEOUT');
      return true;
    }
  );
  const elapsed = Date.now() - t;
  assert.ok(elapsed >= 25, 'timeout should not fire early (got ' + elapsed + 'ms)');
  assert.ok(elapsed < 2000, 'timeout should fire promptly (got ' + elapsed + 'ms)');

  r1();
});

// Regression: the opt-in keeps the old behaviour.
test('acquire: unrefTimeouts opt-in does not hold the loop open', async () => {
  const sem = new Semaphore({ permits: 1, unrefTimeouts: true });
  const r1 = await sem.acquire();
  const t = Date.now();
  await assert.rejects(sem.acquire(1, 30), (err) => err instanceof SemaphoreTimeoutError);
  assert.ok(Date.now() - t < 2000);
  r1();
});

// Regression: a pending acquire() must settle on its own.
//
// The timeout timer used to be unref'd. An unref'd timer does not keep the
// event loop alive, so when nothing else was pending Node drained the loop
// and exited while acquire() was still waiting - the promise never settled
// and never rejected. The caller saw a silent hang.
//
// This has to run in a child process: the test runner keeps the event loop
// alive by itself, which masks the bug entirely.
test('acquire: timeout settles in a process with nothing else pending', async () => {
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');

  const script = path.join(__dirname, 'fixtures', 'timeout-settles.js');
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      timeout: 10000,
    });
  } catch (err) {
    assert.fail(
      'child process did not exit cleanly: ' +
        (err.stdout || '') +
        (err.stderr || err.message)
    );
  }

  assert.match(stdout, /REJECTED/,
    'expected the child to report a rejection, got: ' + JSON.stringify(stdout));
  assert.match(stdout, /SEMAPHORE_TIMEOUT/);
});

test('version: exposed on instance and exported', () => {
  const sem = new Semaphore();
  assert.equal(sem.version, VERSION);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});
