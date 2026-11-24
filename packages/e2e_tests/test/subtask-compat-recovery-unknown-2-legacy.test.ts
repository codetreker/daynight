import { test } from 'node:test';
import { run } from './subtask-compat-recovery-fixture.ts';

test('legacy receipts permit safe compensation without certifying unknown outcomes', async () => await run('legacy'));
