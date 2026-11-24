import { test } from 'node:test';
import { run } from './subtask-compat-recovery-fixture.ts';

test('a late Docker creation is removable by compensation but never verified', async () => await run('late'));
