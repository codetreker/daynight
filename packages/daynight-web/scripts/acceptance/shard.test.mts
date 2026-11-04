import assert from 'node:assert/strict';
import test from 'node:test';
import { functionalScenarios } from './inventory.mts';
import { functionalArguments, ownsSharedChecks, parseShard, readFunctionalCollection, requireSelection, requireShard } from './shard.mts';

const shard = { current: 1, total: 2 } as const;
const collection = (names: readonly string[], selected: typeof shard | { current: 2; total: 2 } | null = null) => ({
  config: { workers: 1, fullyParallel: true, shard: selected, projects: [{ retries: 0, repeatEach: 1 }] },
  errors: [], suites: [{ suites: [{ specs: names.map((description) => ({ tests: [{ expectedStatus: 'passed',
    annotations: [{ type: 'scenario', description }], results: [] }] })) }] }],
});

test('only the two explicit shard identities are accepted and shared checks have one owner', () => {
  for (const current of [1, 2] as const) assert.deepEqual(parseShard(`${current}/2`), { current, total: 2 });
  for (const value of ['', '0/2', '3/2', '1/3', '1/02', ' 1/2', '1/2 ']) assert.throws(() => parseShard(value), /Invalid functional shard/);
  for (const value of [null, [], {}, { current: 0, total: 2 }, { current: 1, total: 3 }, { current: '1', total: 2 },
    { current: 1, total: 2, skip: true }]) assert.throws(() => requireShard(value), /Invalid functional shard/);
  assert.equal(ownsSharedChecks(undefined), true);
  assert.equal(ownsSharedChecks(shard), false);
  assert.equal(ownsSharedChecks({ current: 2, total: 2 }), true);
  assert.deepEqual(functionalArguments(undefined), ['--workers=1', '--retries=0', '--grep-invert', '@capacity']);
  assert.deepEqual(functionalArguments(shard), ['--workers=1', '--retries=0', '--fully-parallel', '--shard=1/2', '--grep-invert', '@capacity']);
});

test('collection validates the complete canonical inventory and each selected subset', () => {
  const half = Math.ceil(functionalScenarios.length / 2);
  assert.deepEqual(readFunctionalCollection(collection([...functionalScenarios].reverse()), undefined), [...functionalScenarios].reverse());
  for (const current of [1, 2] as const) {
    const selected = { current, total: 2 } as const;
    const names = current === 1 ? functionalScenarios.slice(0, half) : functionalScenarios.slice(half);
    assert.deepEqual(readFunctionalCollection(collection(names, selected), selected), names);
    assert.deepEqual(requireSelection(names, selected), names);
  }
  assert.deepEqual(requireSelection(undefined, undefined), functionalScenarios);
  assert.throws(() => requireSelection(functionalScenarios, undefined), /cannot declare a shard selection/);
});

test('unknown, duplicated, missing and incorrectly sized functional selections fail closed', () => {
  const half = functionalScenarios.slice(0, Math.ceil(functionalScenarios.length / 2));
  for (const names of [[], half.slice(1), [...half, functionalScenarios.at(-1)!], [...half.slice(1), half[1]!], [...half.slice(1), 'foreign']]) {
    assert.throws(() => requireSelection(names, shard), /incomplete, duplicated or unknown/);
  }
  for (const names of [functionalScenarios.slice(1), [...functionalScenarios.slice(1), functionalScenarios[1]!], [...functionalScenarios.slice(1), 'foreign']]) {
    assert.throws(() => readFunctionalCollection(collection(names), undefined), /canonical inventory/);
  }
  assert.throws(() => readFunctionalCollection(collection(half, { current: 2, total: 2 }), shard), /different shard/);
  assert.throws(() => readFunctionalCollection(collection(functionalScenarios, shard), undefined), /must be unsharded/);
});

test('collection refuses wrong concurrency, retries, repetitions, annotations and skipped cases', () => {
  for (const field of ['workers', 'fullyParallel', 'projects', 'errors', 'suites'] as const) {
    const value = collection(functionalScenarios);
    if (field === 'workers') value.config.workers = 2;
    else if (field === 'fullyParallel') value.config.fullyParallel = false;
    else if (field === 'projects') value.config.projects = [];
    else if (field === 'errors') (value.errors as unknown[]).push({ message: 'collection failed' });
    else (value as Record<string, unknown>).suites = null;
    assert.throws(() => readFunctionalCollection(value, undefined), /Invalid functional collection/);
  }
  for (const property of ['retries', 'repeatEach'] as const) {
    const value = collection(functionalScenarios);
    value.config.projects[0]![property] = 2;
    assert.throws(() => readFunctionalCollection(value, undefined), /zero retries and one repetition/);
  }
  for (const mode of ['skipped', 'executed', 'missing annotation', 'duplicate annotation', 'multiple tests']) {
    const value = collection(functionalScenarios);
    const spec = value.suites[0]!.suites[0]!.specs[0]!;
    const item = spec.tests[0]!;
    if (mode === 'skipped') item.expectedStatus = 'skipped';
    else if (mode === 'executed') (item.results as unknown[]).push({ status: 'passed' });
    else if (mode === 'missing annotation') item.annotations = [];
    else if (mode === 'duplicate annotation') item.annotations.push(item.annotations[0]!);
    else spec.tests.push(item);
    assert.throws(() => readFunctionalCollection(value, undefined), /Functional collection/);
  }
});
