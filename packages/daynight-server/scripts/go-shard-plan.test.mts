import assert from 'node:assert/strict';
import test from 'node:test';
import { planPackages, shardNames } from './go-shard-plan.mts';

const modulePath = 'example.com/server';
const relative = (name: string) => `${modulePath}/${name}`;
const command = relative('cmd/daynight-server');
const store = relative('internal/core/store/postgres');
const packages = [
  command, modulePath, relative('cmd/integration_tests'), relative('internal/core/store'), store,
  store + '/usage', store + '/identity', store + '/task', store + '/github/queries', store + '/session',
  relative('internal/core/store/postgreslike'), relative('internal/core/store/postgres_tools'),
];

test('assigns every module package except the lifecycle command exactly once', () => {
  const plan = planPackages(packages, modulePath);

  assert.deepEqual(Object.keys(plan), shardNames);
  assert.deepEqual(plan.root, [store]);
  assert.deepEqual(plan['store-a'], ['github/queries', 'identity', 'session', 'task'].map(name => store + '/' + name));
  assert.deepEqual(plan['store-b'], [store + '/usage']);
  assert.deepEqual(plan.other, [
    modulePath, relative('cmd/integration_tests'), relative('internal/core/store'),
    relative('internal/core/store/postgres_tools'), relative('internal/core/store/postgreslike'),
  ]);
  assert.deepEqual(Object.values(plan).flat().sort(), packages.filter(name => name !== command).sort());
  assert.deepEqual(planPackages([...packages].reverse(), modulePath), plan);
});

test('rejects duplicate or foreign package discovery', () => {
  assert.throws(() => planPackages([...packages, store], modulePath), /Duplicate Go server package/);
  assert.throws(() => planPackages([...packages, '../other'], modulePath), /Unexpected package/);
  assert.throws(() => planPackages([...packages, modulePath + '-other/store'], modulePath), /Unexpected package/);
  assert.throws(() => planPackages([...packages, ''], modulePath), /Unexpected package/);
});

test('rejects a missing command or empty shard', () => {
  assert.throws(() => planPackages(packages.filter(name => name !== command), modulePath), /separately verified command/);
  assert.throws(() => planPackages(packages.filter(name => name !== store), modulePath), /No Go server packages assigned to shard root/);
  assert.throws(() => planPackages(packages.filter(name => name !== store + '/usage'), modulePath), /No Go server packages assigned to shard store-b/);
});
