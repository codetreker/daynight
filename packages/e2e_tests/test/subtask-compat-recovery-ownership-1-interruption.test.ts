import { test } from 'node:test';
import { run } from './subtask-compat-recovery-fixture.ts';

test('interruption still removes observed owned resources but preserves unknown outcome', async () => await run('interrupt'));
