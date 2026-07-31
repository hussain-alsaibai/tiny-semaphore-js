'use strict';

/**
 * tiny-semaphore — zero-dependency weighted semaphore for Node.js.
 *
 * @module tiny-semaphore
 * @example
 * const { Semaphore } = require('tiny-semaphore');
 * const sem = new Semaphore({ permits: 5 });
 *
 * const result = await sem.run(async () => {
 *   return await callExternalApi();
 * });
 */

const { Semaphore } = require('./semaphore');

module.exports = { Semaphore };
module.exports.Semaphore = Semaphore;
module.exports.default = Semaphore;
