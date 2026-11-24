import { test } from 'node:test';
import { run } from './subtask-compat-recovery-fixture.ts';

test('legacy probe success cannot certify the authenticated container fixture', async () => await run('legacy-pass'));
