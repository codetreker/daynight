import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('isolated preview names resolve to loopback without replacing ordinary DNS', () => {
  const resolver = fileURLToPath(new URL('../src/resolve-local.cjs', import.meta.url));
  const output = execFileSync(process.execPath, ['--require', resolver, '-e', `
    const dns = require('node:dns');
    const { promisify } = require('node:util');
    const lookup = promisify(dns.lookup);
    Promise.all([
      lookup('app.daynight.localhost', { all: true }),
      lookup('preview.daynight.localhost'),
      lookup('123.preview.daynight.localhost'),
      lookup('localhost'),
    ]).then(values => process.stdout.write(JSON.stringify(values))).catch(error => { console.error(error); process.exitCode = 1; });
  `], { encoding: 'utf8', timeout: 10_000 });
  const result = JSON.parse(output) as [{ address: string; family: number }[], { address: string }, { address: string }, { address: string }];
  assert.deepEqual(result[0], [{ address: '127.0.0.1', family: 4 }]);
  assert.equal(result[1].address, '127.0.0.1');
  assert.equal(result[2].address, '127.0.0.1');
  assert.ok(result[3].address);
});
