import { test } from 'node:test';
import { run } from './subtask-compat-recovery-fixture.ts';

test('cleanup retains resources with a mismatched ownership label', async () => await run('foreign'));
