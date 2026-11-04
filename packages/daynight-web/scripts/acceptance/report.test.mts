import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { aggregateScenarios, readReport, validateShardEvidence, type Scenario } from './report.mts';
import { authCombinedChecks, functionalScenarios as functionalNames } from './inventory.mts';

const report = (names = ['sample-flow']) => ({ errors: [], suites: [{ specs: [], suites: [{ specs: names.map((name) => ({ title: 'sample', ok: true, tests: [{
  expectedStatus: 'passed', status: 'expected', annotations: [{ type: 'scenario', description: name }],
  results: [{ status: 'passed', retry: 0, errors: [], duration: 12, attachments: [{ contentType: 'image/png', path: '/owned/sample.png' }] }],
}] })), suites: [] }] }], stats: { expected: names.length, skipped: 0, flaky: 0, unexpected: 0 } });

test('recursively verifies a first-attempt scenario', () => assert.deepEqual(readReport(report(), ['sample-flow']), [
  { name: 'sample-flow', title: 'sample', durationMs: 12, screenshots: ['/owned/sample.png'] },
]));
test('rejects missing, extra, and duplicate scenarios in a raw report', () => {
  assert.throws(() => readReport(report(), ['sample-flow', 'missing']), /Required acceptance scenario missing: missing/);
  assert.throws(() => readReport(report(['sample-flow', 'extra-flow']), ['sample-flow']), /Unexpected acceptance scenario: extra-flow/);
  assert.throws(() => readReport(report(['sample-flow', 'sample-flow']), ['sample-flow']), /Duplicate acceptance scenario name: sample-flow/);
});
test('rejects empty or malformed reports', () => {
  for (const value of [null, {}, { errors: [], suites: [], stats: {} }]) assert.throws(() => readReport(value, []));
});
test('rejects retries, flaky tests, global errors, and invalid result evidence', () => {
  const cases: { mutate: (value: ReturnType<typeof report>) => void; error: RegExp }[] = [
    { mutate: (value) => { value.errors.push('error' as never); }, error: /global errors/ },
    { mutate: (value) => { value.stats.skipped = 1; }, error: /summary disagrees/ },
    { mutate: (value) => { value.stats.flaky = 1; }, error: /summary disagrees/ },
    { mutate: (value) => { value.stats.unexpected = 1; }, error: /summary disagrees/ },
    { mutate: (value) => { value.stats.expected = 2; }, error: /summary disagrees/ },
    { mutate: (value) => { value.suites[0]!.suites[0]!.specs[0]!.tests[0]!.status = 'flaky'; }, error: /skipped, flaky, or failed/ },
    { mutate: (value) => { value.suites[0]!.suites[0]!.specs[0]!.tests[0]!.results[0]!.retry = 1; }, error: /first attempt/ },
    { mutate: (value) => { value.suites[0]!.suites[0]!.specs[0]!.tests[0]!.results.push({ status: 'passed', retry: 1, errors: [], duration: 12, attachments: [] }); }, error: /Retries are forbidden/ },
    { mutate: (value) => { value.suites[0]!.suites[0]!.specs[0]!.tests[0]!.annotations = []; }, error: /stable scenario annotation/ },
    { mutate: (value) => { value.suites[0]!.suites[0]!.specs[0]!.tests[0]!.results[0]!.attachments = []; }, error: /screenshot attachment/ },
  ];
  for (const { mutate, error } of cases) {
    const value = report();
    mutate(value);
    assert.throws(() => readReport(value, ['sample-flow']), error);
  }
});

const capacityNames = ['capacity-chain', 'capacity-merge', 'capacity-shared', 'capacity-external', 'capacity-limits'] as const;
const stressNativeNames = [...functionalNames, ...capacityNames];
const scenario = (name: string): Scenario => ({ name, title: name, durationMs: 12, screenshots: [`/owned/${name}.png`] });

test('keeps functional and explicit local stress inventory totals distinct', () => {
  assert.equal(functionalNames.length, 35);
  assert.equal(functionalNames.length * 2, 70);
  assert.equal(stressNativeNames.length, 40);
  assert.equal(stressNativeNames.length + functionalNames.length, 75);
});

test('verifies exactly thirty-five functional scenarios for the container target', () => {
  const scenarios = readReport(report([...functionalNames]), functionalNames);
  assert.equal(scenarios.length, functionalNames.length);
  assert.deepEqual(scenarios.map(({ name }) => name), functionalNames);
});

test('normal native acceptance requires exactly the functional inventory and rejects capacity evidence', () => {
  const functional = readReport(report([...functionalNames]), functionalNames);
  assert.deepEqual(aggregateScenarios([functional], functionalNames), functional);
  assert.throws(() => aggregateScenarios([functional, capacityNames.map(scenario)], functionalNames), /Unexpected acceptance scenario: capacity-chain/);
  assert.throws(() => aggregateScenarios([functional.slice(1)], functionalNames), /Required acceptance scenario missing: project-list/);
});

test('local stress acceptance aggregates the complete native functional and capacity inventories', () => {
  const functional = readReport(report([...functionalNames]), functionalNames);
  const capacity = readReport(report([...capacityNames]), capacityNames);
  const phases: readonly (readonly Scenario[])[] = [functional, capacity];
  const scenarios = aggregateScenarios(phases, stressNativeNames);
  assert.equal(scenarios.length, stressNativeNames.length);
  assert.deepEqual(scenarios.map(({ name }) => name), stressNativeNames);
  assert.equal(scenarios[0], functional[0]);
  assert.equal(scenarios[functionalNames.length], capacity[0]);
});

test('requires the automatic-execution journey in each complete target report', () => {
  const withoutPermission = functionalNames.filter((name) => name !== 'task-agent-permission');
  assert.throws(() => readReport(report(withoutPermission), functionalNames), /Required acceptance scenario missing: task-agent-permission/);
  const incompleteFunctional = withoutPermission.map(scenario);
  const capacity = capacityNames.map(scenario);
  assert.throws(() => aggregateScenarios([incompleteFunctional, capacity], stressNativeNames), /Required acceptance scenario missing: task-agent-permission/);
});

test('requires the platform journey in each complete target report', () => {
  const withoutPlatform = functionalNames.filter((name) => name !== 'task-platform');
  assert.throws(() => readReport(report(withoutPlatform), functionalNames), /Required acceptance scenario missing: task-platform/);
  assert.throws(() => aggregateScenarios([withoutPlatform.map(scenario), capacityNames.map(scenario)], stressNativeNames), /Required acceptance scenario missing: task-platform/);
});

for (const name of ['task-assignment', 'task-assignment-layout', 'task-step-status', 'task-step-access-retirement'] as const) {
  test(`requires the ${name} journey in each complete target report`, () => {
    const incomplete = functionalNames.filter((candidate) => candidate !== name);
    assert.throws(() => readReport(report(incomplete), functionalNames), new RegExp(`Required acceptance scenario missing: ${name}`));
    assert.throws(() => aggregateScenarios([incomplete.map(scenario)], functionalNames), new RegExp(`Required acceptance scenario missing: ${name}`));
    assert.throws(() => aggregateScenarios([incomplete.map(scenario), capacityNames.map(scenario)], stressNativeNames), new RegExp(`Required acceptance scenario missing: ${name}`));
  });
}

test('requires the standalone task detail journey in each complete target report', () => {
  const withoutPage = functionalNames.filter((name) => name !== 'task-detail-page');
  assert.throws(() => readReport(report(withoutPage), functionalNames), /Required acceptance scenario missing: task-detail-page/);
  assert.throws(() => aggregateScenarios([withoutPage.map(scenario), capacityNames.map(scenario)], stressNativeNames), /Required acceptance scenario missing: task-detail-page/);
});

test('rejects missing and unexpected scenarios across phases', () => {
  const functional = functionalNames.map(scenario);
  const capacity = capacityNames.map(scenario);
  assert.throws(() => aggregateScenarios([functional, capacity.slice(1)], stressNativeNames), /Required acceptance scenario missing: capacity-chain/);
  assert.throws(() => aggregateScenarios([functional, [...capacity, scenario('extra-flow')]], stressNativeNames), /Unexpected acceptance scenario: extra-flow/);
  assert.throws(() => aggregateScenarios([functional, [...capacity.slice(1), scenario('extra-flow')]], stressNativeNames), /Unexpected acceptance scenario: extra-flow/);
});

test('rejects duplicate scenarios within and across phases', () => {
  const functional = functionalNames.map(scenario);
  const capacity = capacityNames.map(scenario);
  assert.throws(() => aggregateScenarios([[...functional, functional[0]!], capacity], stressNativeNames), /Duplicate acceptance scenario name: project-list/);
  assert.throws(() => aggregateScenarios([functional, [...capacity, functional[0]!]], stressNativeNames), /Duplicate acceptance scenario name: project-list/);
  assert.throws(() => aggregateScenarios([functional, [capacity[0]!, capacity[0]!, ...capacity.slice(2)]], stressNativeNames), /Duplicate acceptance scenario name: capacity-chain/);
});

test('rejects an empty aggregate and duplicate required scenario names', () => {
  assert.throws(() => aggregateScenarios([[], []], stressNativeNames), /No acceptance scenarios ran/);
  assert.throws(() => aggregateScenarios([[scenario('sample-flow')]], ['sample-flow', 'sample-flow']), /Duplicate required acceptance scenario names/);
});

const githubSha = 'a'.repeat(40);
const gitTreeSha = 'b'.repeat(40);
const shardReceipt = (current: 1 | 2, sha = githubSha, tree = gitTreeSha) => {
  const selection = current === 1 ? functionalNames.slice(0, 18) : functionalNames.slice(18);
  const targets = (['native', 'container'] as const).map((target, index) => {
    const baseUrl = `http://127.0.0.1:${current * 10_000 + index + 1}`;
    return { target, baseUrl, result: 'passed', scenarios: selection.map(scenario), phases: [{
      target, baseUrl, phase: 'functional', result: 'passed', browserCleanup: 'passed', scenarios: selection.map(scenario),
    }] };
  });
  return { schemaVersion: 3, mode: 'functional', runId: `shard-${current}`, shard: { current: current as number, total: 2 },
    source: { gitSha: sha, githubSha: sha, gitTreeSha: tree, dirty: false }, result: 'passed', cleanup: 'passed',
    native: { cleanup: 'passed' }, installedCli: { cleanup: 'passed' }, selection: [...selection] as string[], targets,
    authCombined: current === 1 ? [] : targets.map(({ target, baseUrl }) => ({ schemaVersion: 1, kind: 'auth-combined',
      target, origin: baseUrl, sourceGitSha: sha, result: 'passed', cleanup: 'passed', browserCleanup: 'passed',
      checks: authCombinedChecks.map((name) => ({ name, result: 'passed' })),
    })),
  };
};
type ShardReceipt = ReturnType<typeof shardReceipt>;
type ShardPair = [ShardReceipt, ShardReceipt];
const shardPair = (): ShardPair => [shardReceipt(1), shardReceipt(2)];
const replaceSelection = (receipt: ShardReceipt, names: string[]): void => {
  receipt.selection = names;
  for (const target of receipt.targets) {
    target.scenarios = names.map(scenario);
    target.phases[0]!.scenarios = names.map(scenario);
  }
};

test('joins both shard inventories and requires all authentication checks only on shard 2', () => {
  const pair = shardPair();
  validateShardEvidence(pair, githubSha, gitTreeSha);
  validateShardEvidence([...pair].reverse(), githubSha, gitTreeSha);
  assert.equal(pair[0].authCombined.length, 0);
  assert.equal(pair[1].authCombined.flatMap(({ checks }) => checks).length, 22);
});

test('rejects missing, extra, duplicate or invalid shard and run identities', () => {
  const pair = shardPair();
  for (const receipts of [[], [pair[0]], [...pair, pair[0]], [pair[0], pair[0]]]) {
    assert.throws(() => validateShardEvidence(receipts, githubSha, gitTreeSha));
  }
  const cases: ((pair: ShardPair) => void)[] = [
    (value) => { value[1].shard.current = 1; },
    (value) => { value[1].shard.current = 3; },
    (value) => { value[1].shard.total = 3; },
    (value) => { value[1].runId = value[0].runId; },
    (value) => { value[0].runId = ''; },
  ];
  for (const mutate of cases) {
    const value = shardPair(); mutate(value);
    assert.throws(() => validateShardEvidence(value, githubSha, gitTreeSha));
  }
});

test('requires both receipts to match the actual clean checkout revision and tree', () => {
  for (const expected of ['', 'not-a-sha']) {
    assert.throws(() => validateShardEvidence(shardPair(), expected, gitTreeSha), /current checkout source/);
    assert.throws(() => validateShardEvidence(shardPair(), githubSha, expected), /current checkout source/);
  }
  const cases: ((pair: ShardPair) => void)[] = [
    (pair) => { pair[0].source.gitSha = 'c'.repeat(40); },
    (pair) => { pair[1].source.githubSha = 'c'.repeat(40); },
    (pair) => { pair[1].source.gitTreeSha = 'c'.repeat(40); },
    (pair) => { for (const value of pair) value.source.gitTreeSha = 'c'.repeat(40); },
    (pair) => { pair[0].source.dirty = true; },
  ];
  for (const mutate of cases) {
    const pair = shardPair(); mutate(pair);
    assert.throws(() => validateShardEvidence(pair, githubSha, gitTreeSha), /clean current checkout/);
  }
});

test('rejects incomplete run, target, phase, browser and owned cleanup results', () => {
  const cases: ((pair: ShardPair) => void)[] = [
    (pair) => { pair[0].schemaVersion = 4; },
    (pair) => { pair[0].mode = 'stress'; },
    (pair) => { pair[0].result = 'running'; },
    (pair) => { pair[1].cleanup = 'pending'; },
    (pair) => { pair[0].native.cleanup = 'failed'; },
    (pair) => { pair[1].installedCli.cleanup = 'pending'; },
    (pair) => { pair[0].targets.pop(); },
    (pair) => { pair[0].targets[1]!.target = 'native'; },
    (pair) => { pair[1].targets[0]!.result = 'failed'; },
    (pair) => { pair[0].targets[0]!.baseUrl = 'http://example.com'; },
    (pair) => { pair[0].targets[0]!.phases = []; },
    (pair) => { pair[0].targets[0]!.phases.push(pair[0].targets[0]!.phases[0]!); },
    (pair) => { pair[0].targets[0]!.phases[0]!.phase = 'capacity'; },
    (pair) => { pair[0].targets[0]!.phases[0]!.target = 'container'; },
    (pair) => { pair[0].targets[0]!.phases[0]!.baseUrl = 'http://127.0.0.1:29999'; },
    (pair) => { pair[0].targets[0]!.phases[0]!.result = 'failed'; },
    (pair) => { pair[0].targets[0]!.phases[0]!.browserCleanup = 'pending'; },
  ];
  for (const mutate of cases) {
    const pair = shardPair(); mutate(pair);
    assert.throws(() => validateShardEvidence(pair, githubSha, gitTreeSha));
  }
});

test('rejects omitted, repeated, unexpected or mismatched selected scenario evidence', () => {
  const cases: ((pair: ShardPair) => void)[] = [
    (pair) => { replaceSelection(pair[1], pair[1].selection.slice(1)); },
    (pair) => { replaceSelection(pair[1], [...pair[1].selection, pair[0].selection[0]!]); },
    (pair) => { replaceSelection(pair[0], []); },
    (pair) => { pair[0].selection.push(pair[0].selection[0]!); },
    (pair) => { replaceSelection(pair[0], ['unexpected-flow', ...pair[0].selection.slice(1)]); },
    (pair) => { pair[0].targets[0]!.scenarios.pop(); },
    (pair) => { pair[0].targets[1]!.phases[0]!.scenarios.pop(); },
    (pair) => { pair[0].targets[1]!.scenarios.push(pair[0].targets[1]!.scenarios[0]!); },
    (pair) => { pair[1].targets[0]!.scenarios[0]!.durationMs = NaN; },
    (pair) => { pair[1].targets[1]!.scenarios[0]!.screenshots = []; },
  ];
  for (const mutate of cases) {
    const pair = shardPair(); mutate(pair);
    assert.throws(() => validateShardEvidence(pair, githubSha, gitTreeSha));
  }
});

test('rejects wrong authentication ownership, source, cleanup and incomplete check names', () => {
  const cases: ((pair: ShardPair) => void)[] = [
    (pair) => { pair[0].authCombined = pair[1].authCombined; },
    (pair) => { pair[1].authCombined = []; },
    (pair) => { pair[1].authCombined.pop(); },
    (pair) => { pair[1].authCombined[1]!.target = 'native'; },
    (pair) => { pair[1].authCombined[0]!.sourceGitSha = 'c'.repeat(40); },
    (pair) => { pair[1].authCombined[0]!.origin = 'http://127.0.0.1:29999'; },
    (pair) => { pair[1].authCombined[0]!.schemaVersion = 2; },
    (pair) => { pair[1].authCombined[0]!.kind = 'other'; },
    (pair) => { pair[1].authCombined[0]!.result = 'running'; },
    (pair) => { pair[1].authCombined[0]!.cleanup = 'pending'; },
    (pair) => { pair[1].authCombined[0]!.browserCleanup = 'failed'; },
    (pair) => { pair[1].authCombined[0]!.checks.pop(); },
    (pair) => { pair[1].authCombined[0]!.checks[0]!.name = pair[1].authCombined[0]!.checks[1]!.name; },
    (pair) => { pair[1].authCombined[0]!.checks[0]!.result = 'failed'; },
  ];
  for (const mutate of cases) {
    const pair = shardPair(); mutate(pair);
    assert.throws(() => validateShardEvidence(pair, githubSha, gitTreeSha));
  }
});

test('the install-free shard CLI validates receipts against its checkout and rejects missing inputs', async (context) => {
  const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  await mkdir(join(repositoryRoot, '.tmp'), { recursive: true });
  const directory = await mkdtemp(join(repositoryRoot, '.tmp/shard-reports-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const [sha, tree] = execFileSync('git', ['rev-parse', 'HEAD', 'HEAD^{tree}'], { cwd: repositoryRoot, encoding: 'utf8', timeout: 10_000 }).trim().split('\n');
  assert.ok(sha); assert.ok(tree);
  const paths = [join(directory, 'one.json'), join(directory, 'two.json')];
  await Promise.all(paths.map((path, index) => writeFile(path, JSON.stringify(shardReceipt(index === 0 ? 1 : 2, sha, tree)))));
  const script = fileURLToPath(new URL('./report.mts', import.meta.url));
  const env = { ...process.env, GITHUB_SHA: sha };
  const run = (args: string[], environment: NodeJS.ProcessEnv) => spawnSync(process.execPath, [script, ...args], { cwd: directory, env: environment, encoding: 'utf8', timeout: 10_000 });
  const passed = run(['--shards', ...paths], env);
  assert.equal(passed.error, undefined); assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /Both Web shards passed/);
  const missing = run(['--shards', paths[0]!], env);
  assert.equal(missing.status, 1); assert.match(missing.stderr, /Usage:/);
  const absentFile = run(['--shards', paths[0]!, join(directory, 'missing.json')], env);
  assert.equal(absentFile.status, 1); assert.match(absentFile.stderr, /ENOENT/);
  const extra = run(['--shards', ...paths, paths[0]!], env);
  assert.equal(extra.status, 1); assert.match(extra.stderr, /Usage:/);
  const wrongHead = run(['--shards', ...paths], { ...env, GITHUB_SHA: 'c'.repeat(40) });
  assert.equal(wrongHead.status, 1); assert.match(wrongHead.stderr, /GITHUB_SHA does not match/);
  const missingEnv: NodeJS.ProcessEnv = { ...env }; delete missingEnv.GITHUB_SHA;
  const noSource = run(['--shards', ...paths], missingEnv);
  assert.equal(noSource.status, 1); assert.match(noSource.stderr, /requires GITHUB_SHA/);
  await Promise.all(paths.map((path, index) => writeFile(path, JSON.stringify(shardReceipt(index === 0 ? 1 : 2, sha, 'c'.repeat(40))))));
  const wrongTree = run(['--shards', ...paths], env);
  assert.equal(wrongTree.status, 1); assert.match(wrongTree.stderr, /clean current checkout/);
});
