import { test } from 'node:test';
import { run } from './subtask-compat-recovery-fixture.ts';

test('build failure persists bounded redacted phase diagnostics', async () => await run('build-failure'));
