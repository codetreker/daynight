import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { parseAcceptanceArguments } from './arguments.mts';

test('acceptance arguments separate complete, target, callback and recovery invocations', () => {
  assert.deepEqual(parseAcceptanceArguments([]), { command: 'acceptance', scope: 'all', allowApfsImage: false, package: undefined });
  for (const scope of ['all', 'native', 'container']) assert.deepEqual(parseAcceptanceArguments(['--target', scope]),
    { command: 'acceptance', scope, allowApfsImage: false, package: undefined });
  assert.deepEqual(parseAcceptanceArguments(['--container']), { command: 'callback' });
  assert.deepEqual(parseAcceptanceArguments(['--cleanup']), { command: 'cleanup', runId: undefined });
  assert.deepEqual(parseAcceptanceArguments(['--cleanup', '20261029000000-id']), { command: 'cleanup', runId: '20261029000000-id' });
  assert.deepEqual(parseAcceptanceArguments(['--target', 'native', '--apfs']), { command: 'acceptance', scope: 'native', allowApfsImage: true, package: undefined });
});

test('package producer identity is supplied explicitly and independently of the consumer attempt', () => {
  assert.deepEqual(parseAcceptanceArguments(['--target', 'container', '--cli-package', '.tmp/package', '--producer-run', '12345', '--producer-attempt', '2']),
    { command: 'acceptance', scope: 'container', allowApfsImage: false, package: { directory: resolve('.tmp/package'), runId: '12345', originAttempt: 2 } });
});

test('ambiguous, incomplete and unsupported invocations fail before acceptance work', () => {
  for (const args of [
    ['unknown'], ['--target'], ['--target', 'unknown'], ['--target', 'native', '--target', 'container'], ['--apfs', '--apfs'],
    ['--target', 'container', '--apfs'], ['--container', '--apfs'], ['--cleanup', '--target', 'native'], ['--cleanup', 'id', 'extra'],
    ['--cli-package', 'dir'], ['--producer-run', '123'], ['--producer-attempt', '1'],
    ['--cli-package', 'dir', '--producer-run', '0', '--producer-attempt', '1'],
    ['--cli-package', 'dir', '--producer-run', '123', '--producer-attempt', '01'],
    ['--cli-package', 'dir', '--producer-run', '123', '--producer-attempt', '9007199254740992'],
  ]) assert.throws(() => parseAcceptanceArguments(args), /Usage:/);
});
