import { test } from 'node:test';
import { run } from './subtask-compat-recovery-fixture.ts';

test('failed go test retains bounded redacted diagnostics and cleans owned resources', async () => await run('failure'));
