import { test } from 'node:test';
import { run } from './subtask-compat-recovery-fixture.ts';

test('acceptance requires the baseline npm CLI and never falls back to the unauthenticated probe', async () => await run('acceptance-default'));
