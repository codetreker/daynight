import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateAcceptanceCompletion, verifyCompletionFiles, type AcceptanceCompletion, type CompletionExpectation } from './completion.mts';
import { requiredCombinedChecks } from './auth-combined-report.mts';
import { capacityScenarios, functionalScenarios, type AcceptanceScope } from './inventory.mts';

const source = { gitSha: 'a'.repeat(40), gitTreeSha: 'b'.repeat(40), githubSha: 'a'.repeat(40), dirty: false };
const browser = { name: 'chromium', version: '156.0.8078.4', platform: 'linux', executableOverride: false };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const at = (second: number) => new Date(Date.UTC(2026, 9, 29, 0, 0, second)).toISOString();
const expected = (scope: AcceptanceScope): CompletionExpectation => ({ scope, source, platform: 'linux', ci: true });
const performance = () => ({ schemaVersion: 1, result: 'passed', datasets: ['chain', 'merge', 'shared', 'external'].map((kind) => ({
  scenario: `capacity-${kind}`, result: 'passed', nodes: 1000, edges: kind === 'chain' ? 999 : 5000, networkMs: 1,
  visibility: Array.from({ length: 5 }, (_, repetition) => ({ repetition, selectedId: 'selected', hiddenUpstream: 20,
    overviewNodes: 10, overviewEdges: 9, addedNodes: 20, addedEdges: 20, expandedNodes: 30, expandedEdges: 29, resetNodes: 10, resetEdges: 9 })),
  measurements: Array.from({ length: 5 }, () => ({ openMs: 100, selectMs: 100, detailMs: 100, zoomMs: 100, panMs: 100, detailNetworkMs: 1, layoutMs: 10, renderMs: 10 })),
})), limits: { node: { status: 409, nodeCount: 1001, edgeCount: 0, maxNodes: 1000, maxEdges: 5000 },
  edge: { status: 409, nodeCount: 1000, edgeCount: 5001, maxNodes: 1000, maxEdges: 5000 } } });

const fixture = (scope: AcceptanceScope): AcceptanceCompletion => {
  const files: AcceptanceCompletion['files'] = [];
  const add = (path: string): string => { files.push({ path, sha256: 'c'.repeat(64), size: 1 }); return path; };
  const targets: AcceptanceCompletion['targets'] = (scope === 'all' ? ['native', 'container'] as const : [scope]).map((target) => {
    const phases: AcceptanceCompletion['targets'][number]['phases'] = (target === 'native' ? ['functional', 'capacity'] as const : ['functional'] as const).map((phase) => {
      const prefix = target === 'native' ? `native/${phase}/` : 'container/';
      for (const name of ['playwright.json', 'target.json', 'browser.json']) add(`${prefix}${name}`);
      return { phase, startedAt: at(target === 'container' ? 4 : phase === 'capacity' ? 6 : 1), finishedAt: at(target === 'container' ? 5 : phase === 'capacity' ? 8 : 2), browser,
        scenarios: (phase === 'capacity' ? capacityScenarios : functionalScenarios).map((name) => ({ name, title: name, durationMs: 1, screenshots: [add(`${prefix}${name}.png`)] })) };
    });
    const prefix = `${target}/auth-combined/`;
    add(`${prefix}target.json`);
    const binaryOrImage = target === 'native' ? 'd'.repeat(64) : `sha256:${'e'.repeat(64)}`;
    return { target, baseUrl: 'http://127.0.0.1:12345', phases,
      authCombined: { schemaVersion: 1, kind: 'auth-combined', target, sourceGitSha: source.gitSha, origin: 'http://127.0.0.1:12345',
        result: 'passed', startedAt: at(target === 'native' ? 2 : 5), finishedAt: at(target === 'native' ? 3 : 6), cleanup: 'passed', browserCleanup: 'passed', browser,
        installedCli: { version: '1.0.0', sourceGitSha: source.gitSha, entrySha256: 'f'.repeat(64), tarballSha256: '0'.repeat(64) },
        checks: requiredCombinedChecks.map((name) => ({ name, result: 'passed', details: {} })), screenshots: [add(`${prefix}first.png`), add(`${prefix}last.png`)],
        restart: { target, origin: 'http://127.0.0.1:12345', startedAt: at(2), readyAt: at(3), before: { pid: 123, start: 'before' }, after: { pid: 124, start: 'after' }, binaryOrImage,
          ...(target === 'container' ? { containerId: '1'.repeat(64) } : {}) } },
      runtime: target === 'native' ? { kind: 'native', binarySha256: binaryOrImage, postgresImageId: `sha256:${'2'.repeat(64)}`, postgresVersion: 'postgres (PostgreSQL) 18.6 (Debian)' }
        : { kind: 'container', imageId: binaryOrImage, runId: '20261029000000-123-12345', containerIds: ['1'.repeat(64)] } };
  });
  const stages = scope === 'container' ? [{ name: 'cli-preparation', startedAt: at(0), finishedAt: at(1) }, { name: 'container', startedAt: at(1), finishedAt: at(6) }]
    : [{ name: 'native-preparation', startedAt: at(0), finishedAt: at(1) }, { name: 'native-functional', startedAt: at(1), finishedAt: at(3) },
      ...(scope === 'all' ? [{ name: 'container-release', startedAt: at(3), finishedAt: at(4) }, { name: 'container', startedAt: at(0), finishedAt: at(6) }] : []),
      { name: 'native-capacity', startedAt: at(6), finishedAt: at(8) }];
  if (scope !== 'container') {
    add('native/capacity/performance.json');
    for (const kind of ['chain', 'merge', 'shared', 'external']) for (let repetition = 0; repetition < 5; repetition++) add(`native/capacity/results/capacity-${kind}-repetition-${repetition}-chromium-trace.json`);
  }
  return { schemaVersion: 1, scope, runId: '20261029000000-12345678-1234-1234-1234-123456789abc', source,
    result: 'passed', cleanup: 'passed', startedAt: at(0), finishedAt: at(9),
    installedCli: { packageVersion: '1.0.0', tarballSha256: '0'.repeat(64), entrySha256: 'f'.repeat(64) }, targets, stages, files,
    ...(scope === 'container' ? {} : { performance: performance() }) };
};

test('complete and standalone evidence retain their exact target, browser, auth and capacity inventories', () => {
  for (const scope of ['all', 'native', 'container'] as const) {
    const value = fixture(scope);
    assert.equal(validateAcceptanceCompletion(value, expected(scope)), value);
    assert.equal(JSON.stringify(value).includes('processIdentity'), false);
    assert.equal(value.files.every((file) => !file.path.startsWith('/')), true);
  }
});

test('completion rejects omitted or forged results, resources, file identities and phase ordering', () => {
  const changes: ((value: AcceptanceCompletion) => void)[] = [
    (value) => { value.targets.pop(); },
    (value) => { value.targets.push(value.targets[0]!); },
    (value) => { value.targets[0]!.phases.pop(); },
    (value) => { value.targets[0]!.phases[0]!.scenarios.pop(); },
    (value) => { value.targets[0]!.phases[0]!.scenarios[0]!.screenshots = []; },
    (value) => { value.files.pop(); },
    (value) => { value.files[0]!.path = '../outside'; },
    (value) => { value.files[0]!.sha256 = 'wrong'; },
    (value) => { value.targets[1]!.phases[0]!.browser = { ...browser, version: '155.0.0.0' }; },
    (value) => { value.targets[0]!.authCombined.installedCli.entrySha256 = '9'.repeat(64); },
    (value) => { value.stages.find((stage) => stage.name === 'native-capacity')!.startedAt = at(5); },
    (value) => { value.targets[1]!.authCombined.restart!.binaryOrImage = 'sha256:wrong'; },
  ];
  for (const change of changes) {
    const value = fixture('all');
    change(value);
    assert.throws(() => validateAcceptanceCompletion(value, expected('all')));
  }
  const wrongSource = fixture('all'); wrongSource.source = { ...source, gitSha: '9'.repeat(40) };
  assert.throws(() => validateAcceptanceCompletion(wrongSource, expected('all')), /source differs/);
  const scope = fixture('container'); scope.performance = performance();
  assert.throws(() => validateAcceptanceCompletion(scope, expected('container')), /cannot contain native/);
});

test('portable file verification checks bytes and refuses missing evidence or a symbolic-link escape', async () => {
  const temporary = fileURLToPath(new URL('../../.tmp/', import.meta.url));
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(join(temporary, 'completion-files-'));
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const completion = fixture('container');
  completion.files = [{ path: 'image.png', sha256: hash(png), size: png.length }];
  try {
    await writeFile(join(directory, 'image.png'), png);
    await verifyCompletionFiles(completion, directory);
    await writeFile(join(directory, 'image.png'), 'changed');
    await assert.rejects(verifyCompletionFiles(completion, directory), /size or digest differs/);
    await rm(join(directory, 'image.png'));
    await assert.rejects(verifyCompletionFiles(completion, directory), { code: 'ENOENT' });
    if (process.platform !== 'win32') {
      await writeFile(join(directory, 'real.png'), png);
      await symlink(join(directory, 'real.png'), join(directory, 'image.png'));
      await assert.rejects(verifyCompletionFiles(completion, directory), /symbolic link/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
