import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceInstructionReader, type DeviceInstructions } from '../src/subtask-compat-recovery-device.ts';

test('device instructions are assembled from stderr chunks exactly once', () => {
  const published: DeviceInstructions[] = [];
  const read = deviceInstructionReader(value => published.push(value));
  read('stdout', 'unrelated output\n');
  read('stderr', 'Sign in\nOp');
  read('stderr', 'en https://example.test/device\nEnter co');
  read('stderr', 'de: ABCD-');
  assert.deepEqual(published, []);
  read('stderr', '1234\n');
  read('stderr', 'Open https://example.test/other\nEnter code: OTHER\n');
  assert.deepEqual(published, [{ uri: 'https://example.test/device', code: 'ABCD-1234' }]);
});

test('device instructions do not combine separate streams', () => {
  const published: DeviceInstructions[] = [];
  const read = deviceInstructionReader(value => published.push(value));
  read('stdout', 'Open https://example.test/device\n');
  read('stderr', 'Enter code: ABCD-1234\n');
  assert.deepEqual(published, []);
});
