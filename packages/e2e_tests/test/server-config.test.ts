import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { writeServerConfig } from '../src/server-config.ts';

test('server configuration is private and preserves serialized credentials and types', async () => {
  const temporary = path.resolve('.tmp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, 'e2e-server-config-'));
  try {
    const secret = 'quote " newline\n hash # colon : backslash \\';
    await writeServerConfig(root, {
      listenAddress: '127.0.0.1:1234', publicOrigin: 'http://127.0.0.1:4321',
      databaseURL: 'postgres://example/db?value=%23', storageRoot: 'storage',
      authURL: 'http://127.0.0.1:5678', appId: 'example', appSecret: secret,
      callbackURL: 'http://127.0.0.1:4321/auth/callback',
    });
    const directory = path.join(root, 'config');
    const filename = path.join(directory, 'config.yml');
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    const configuration = JSON.parse(await readFile(filename, 'utf8'));
    assert.equal(configuration.uniauth.app_secret, secret);
    assert.equal(configuration.uniauth.allow_loopback_http, true);
    assert.equal(configuration.server.allow_http_test_origin, true);
    assert.equal(configuration.database.url, 'postgres://example/db?value=%23');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
