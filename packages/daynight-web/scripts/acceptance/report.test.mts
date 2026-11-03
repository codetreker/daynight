import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateScenarios, readReport, type Scenario } from './report.mts';

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

const functionalNames = ['project-list', 'project-graph', 'detail-navigation', 'refresh-staleness',
  'failure-recovery', 'deep-links', 'keyboard-focus', 'narrow-layout', 'task-attachments', 'task-detail-page', 'project-view-tabs',
  'language-startup-preferences', 'language-state-preservation', 'language-errors-and-narrow',
  'task-description-markdown', 'task-status', 'task-status-conflicts', 'task-status-recovery', 'task-status-transitions', 'task-agent-permission', 'task-platform',
  'auth-login-session', 'auth-project-isolation', 'auth-project-members', 'auth-personal-tokens', 'auth-invitations', 'auth-resource-session', 'project-settings', 'task-execution-time'] as const;
const capacityNames = ['capacity-chain', 'capacity-merge', 'capacity-shared', 'capacity-external', 'capacity-limits'] as const;
const nativeNames = [...functionalNames, ...capacityNames];
const scenario = (name: string): Scenario => ({ name, title: name, durationMs: 12, screenshots: [`/owned/${name}.png`] });

test('verifies exactly twenty-nine functional scenarios for the container target', () => {
  const scenarios = readReport(report([...functionalNames]), functionalNames);
  assert.equal(scenarios.length, 29);
  assert.deepEqual(scenarios.map(({ name }) => name), functionalNames);
});

test('normal native acceptance requires exactly the functional inventory and rejects capacity evidence', () => {
  const functional = readReport(report([...functionalNames]), functionalNames);
  assert.deepEqual(aggregateScenarios([functional], functionalNames), functional);
  assert.throws(() => aggregateScenarios([functional, capacityNames.map(scenario)], functionalNames), /Unexpected acceptance scenario: capacity-chain/);
  assert.throws(() => aggregateScenarios([functional.slice(1)], functionalNames), /Required acceptance scenario missing: project-list/);
});

test('local stress acceptance aggregates native functional and capacity reports into exactly thirty-four scenarios', () => {
  const functional = readReport(report([...functionalNames]), functionalNames);
  const capacity = readReport(report([...capacityNames]), capacityNames);
  const phases: readonly (readonly Scenario[])[] = [functional, capacity];
  const scenarios = aggregateScenarios(phases, nativeNames);
  assert.equal(scenarios.length, 34);
  assert.deepEqual(scenarios.map(({ name }) => name), nativeNames);
  assert.equal(scenarios[0], functional[0]);
  assert.equal(scenarios[29], capacity[0]);
});

test('requires the automatic-execution journey in each complete target report', () => {
  const withoutPermission = functionalNames.filter((name) => name !== 'task-agent-permission');
  assert.throws(() => readReport(report(withoutPermission), functionalNames), /Required acceptance scenario missing: task-agent-permission/);
  const incompleteFunctional = withoutPermission.map(scenario);
  const capacity = capacityNames.map(scenario);
  assert.throws(() => aggregateScenarios([incompleteFunctional, capacity], nativeNames), /Required acceptance scenario missing: task-agent-permission/);
});

test('requires the platform journey in each complete target report', () => {
  const withoutPlatform = functionalNames.filter((name) => name !== 'task-platform');
  assert.throws(() => readReport(report(withoutPlatform), functionalNames), /Required acceptance scenario missing: task-platform/);
  assert.throws(() => aggregateScenarios([withoutPlatform.map(scenario), capacityNames.map(scenario)], nativeNames), /Required acceptance scenario missing: task-platform/);
});

test('requires the standalone task detail journey in each complete target report', () => {
  const withoutPage = functionalNames.filter((name) => name !== 'task-detail-page');
  assert.throws(() => readReport(report(withoutPage), functionalNames), /Required acceptance scenario missing: task-detail-page/);
  assert.throws(() => aggregateScenarios([withoutPage.map(scenario), capacityNames.map(scenario)], nativeNames), /Required acceptance scenario missing: task-detail-page/);
});

test('rejects missing and unexpected scenarios across phases', () => {
  const functional = functionalNames.map(scenario);
  const capacity = capacityNames.map(scenario);
  assert.throws(() => aggregateScenarios([functional, capacity.slice(1)], nativeNames), /Required acceptance scenario missing: capacity-chain/);
  assert.throws(() => aggregateScenarios([functional, [...capacity, scenario('extra-flow')]], nativeNames), /Unexpected acceptance scenario: extra-flow/);
  assert.throws(() => aggregateScenarios([functional, [...capacity.slice(1), scenario('extra-flow')]], nativeNames), /Unexpected acceptance scenario: extra-flow/);
});

test('rejects duplicate scenarios within and across phases', () => {
  const functional = functionalNames.map(scenario);
  const capacity = capacityNames.map(scenario);
  assert.throws(() => aggregateScenarios([[...functional, functional[0]!], capacity], nativeNames), /Duplicate acceptance scenario name: project-list/);
  assert.throws(() => aggregateScenarios([functional, [...capacity, functional[0]!]], nativeNames), /Duplicate acceptance scenario name: project-list/);
  assert.throws(() => aggregateScenarios([functional, [capacity[0]!, capacity[0]!, ...capacity.slice(2)]], nativeNames), /Duplicate acceptance scenario name: capacity-chain/);
});

test('rejects an empty aggregate and duplicate required scenario names', () => {
  assert.throws(() => aggregateScenarios([[], []], nativeNames), /No acceptance scenarios ran/);
  assert.throws(() => aggregateScenarios([[scenario('sample-flow')]], ['sample-flow', 'sample-flow']), /Duplicate required acceptance scenario names/);
});
