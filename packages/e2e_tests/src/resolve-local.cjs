// Keep the isolated multi-host topology independent of the host DNS resolver.
const dns = require('node:dns');
const { promisify } = require('node:util');
const lookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
  if (typeof hostname !== 'string' || !/^(?:app\.daynight\.localhost|(?:[a-z0-9-]+\.)?preview\.daynight\.localhost)$/.test(hostname)) {
    return lookup.apply(this, arguments);
  }
  if (typeof options === 'function') { callback = options; options = {}; }
  if (typeof options === 'number') options = { family: options };
  options ??= {};
  if (options.family === 6) {
    const error = Object.assign(new Error(`No IPv6 address for ${hostname}`), { code: 'ENOTFOUND' });
    return process.nextTick(callback, error);
  }
  if (options.all) return process.nextTick(callback, null, [{ address: '127.0.0.1', family: 4 }]);
  return process.nextTick(callback, null, '127.0.0.1', 4);
};
dns.lookup[promisify.custom] = (hostname, options) => new Promise((resolve, reject) => {
  dns.lookup(hostname, options, (error, address, family) => {
    if (error) reject(error);
    else resolve(Array.isArray(address) ? address : { address, family });
  });
});
