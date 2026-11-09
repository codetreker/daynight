import assert from 'node:assert/strict';
import { isAbsolute, join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runValidation } from './testdata/validation-fixture.mts';

test('coverage owners resolve overlay paths from the module and clear inherited gate settings', async (t) => {
  for (const entry of ['check', 'startup-shutdown'] as const) {
    const { result, trace, fixture, overlay } = await runValidation(t, entry, undefined, {
      THRESHOLD_TOTAL: '0', EXCLUDE_PACKAGES: 'internal', BUILD_TAGS: 'stress', COVERPROFILE: 'other.out',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(trace, /CONFIG_ENV=unset,unset,unset,unset/);
    assert.equal(Object.keys(overlay.Replace).length, 3);
    for (const [source, target] of Object.entries(overlay.Replace)) {
      assert.ok(isAbsolute(source));
      assert.ok(isAbsolute(target));
      assert.ok(source.startsWith(join(fixture, 'internal/service/webui/dist/')));
      assert.ok(target.startsWith(join(fixture, 'internal/service/webui/testdata/')));
    }
    assert.ok(trace.includes(`-overlay=${join(fixture, '.tmp/unit-overlay.json')}`));
  }
});

test('every command test explicitly requires the lifecycle entry', async () => {
  const directory = fileURLToPath(new URL('../cmd/daynight-server/', import.meta.url));
  for (const file of (await readdir(directory)).filter(file => file.endsWith('_test.go'))) {
    const firstLine = (await readFile(join(directory, file), 'utf8')).split('\n')[0]!;
    assert.match(firstLine, /^\/\/go:build startupshutdown(?: && .+)?$/, file);
  }
});
