import { test } from 'node:test';
import { run } from './subtask-compat-recovery-fixture.ts';

test('compensation cannot overlap the original recovery owner', async () => await run('locked'));
