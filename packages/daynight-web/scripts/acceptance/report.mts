import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { authCombinedChecks, functionalScenarios, validAdmittedRemoval } from './inventory.mts';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid Playwright report object.');
  return value as ObjectValue;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error('Invalid Playwright report array.');
  return value;
};

export type Scenario = { name: string; title: string; durationMs: number; screenshots: string[] };

export const aggregateScenarios = (phases: readonly (readonly Scenario[])[], required: readonly string[]): Scenario[] => {
  const requiredNames = new Set(required);
  if (requiredNames.size !== required.length) throw new Error('Duplicate required acceptance scenario names.');
  const scenarios = phases.flat();
  if (scenarios.length === 0) throw new Error('No acceptance scenarios ran.');
  const names = new Set<string>();
  for (const scenario of scenarios) {
    if (names.has(scenario.name)) throw new Error(`Duplicate acceptance scenario name: ${scenario.name}`);
    names.add(scenario.name);
    if (!requiredNames.has(scenario.name)) throw new Error(`Unexpected acceptance scenario: ${scenario.name}`);
  }
  for (const name of required) if (!names.has(name)) throw new Error(`Required acceptance scenario missing: ${name}`);
  return scenarios;
};

export const readReport = (value: unknown, required: readonly string[]): Scenario[] => {
  const report = object(value);
  if (array(report.errors).length !== 0) throw new Error('Playwright reported global errors.');
  const scenarios: Scenario[] = [];
  const visit = (raw: unknown): void => {
    const suite = object(raw);
    for (const rawSpec of array(suite.specs)) {
      const spec = object(rawSpec);
      if (spec.ok !== true || typeof spec.title !== 'string') throw new Error('Playwright spec did not pass.');
      const tests = array(spec.tests);
      if (tests.length !== 1) throw new Error('Expected exactly one project result per selected spec.');
      const test = object(tests[0]);
      if (test.expectedStatus !== 'passed' || test.status !== 'expected') throw new Error('Playwright test was skipped, flaky, or failed.');
      const results = array(test.results);
      if (results.length !== 1) throw new Error('Retries are forbidden in acceptance results.');
      const result = object(results[0]);
      if (result.status !== 'passed' || result.retry !== 0 || array(result.errors).length !== 0
        || typeof result.duration !== 'number' || !Number.isFinite(result.duration) || result.duration < 0) {
        throw new Error('Playwright result did not pass on its first attempt.');
      }
      const annotations = array(test.annotations).map(object).filter((annotation) => annotation.type === 'scenario');
      if (annotations.length !== 1 || typeof annotations[0]!.description !== 'string' || !/^[a-z][a-z0-9-]+$/.test(annotations[0]!.description)) {
        throw new Error('Each acceptance spec requires one stable scenario annotation.');
      }
      const screenshots = array(result.attachments).map(object)
        .filter((attachment) => attachment.contentType === 'image/png' && typeof attachment.path === 'string')
        .map((attachment) => attachment.path as string);
      if (screenshots.length === 0) throw new Error('Acceptance scenario is missing its screenshot attachment.');
      scenarios.push({ name: annotations[0]!.description, title: spec.title, durationMs: result.duration, screenshots });
    }
    for (const child of suite.suites === undefined ? [] : array(suite.suites)) visit(child);
  };
  for (const suite of array(report.suites)) visit(suite);
  const verifiedScenarios = aggregateScenarios([scenarios], required);
  const stats = object(report.stats);
  if (stats.unexpected !== 0 || stats.flaky !== 0 || stats.skipped !== 0 || stats.expected !== scenarios.length) {
    throw new Error('Playwright summary disagrees with successful scenarios.');
  }
  return verifiedScenarios;
};

const requireShardEvidence: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`Invalid acceptance shard evidence: ${message}`);
};
const shardScenarios = (value: unknown): Scenario[] => array(value).map((raw) => {
  const scenario = object(raw);
  requireShardEvidence(typeof scenario.name === 'string' && /^[a-z][a-z0-9-]+$/.test(scenario.name)
    && typeof scenario.title === 'string' && typeof scenario.durationMs === 'number'
    && Number.isFinite(scenario.durationMs) && scenario.durationMs >= 0, 'malformed scenario.');
  const screenshots = array(scenario.screenshots);
  requireShardEvidence(screenshots.length > 0 && screenshots.every((path) => typeof path === 'string' && path.length > 0), 'scenario screenshots missing.');
  return { name: scenario.name, title: scenario.title, durationMs: scenario.durationMs, screenshots: screenshots as string[] };
});

type ShardTarget = { target: 'native' | 'container'; baseUrl: string; scenarios: Scenario[] };
const shardTargets = (value: unknown, required: readonly string[]): ShardTarget[] => {
  const targets = array(value).map(object);
  requireShardEvidence(targets.length === 2 && new Set(targets.map(({ target }) => target)).size === 2
    && targets.every(({ target }) => target === 'native' || target === 'container'), 'native and container targets are required exactly once.');
  const verified = targets.map((target): ShardTarget => {
    requireShardEvidence(target.result === 'passed' && typeof target.baseUrl === 'string'
      && /^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(target.baseUrl), 'target identity or result differs.');
    const phases = array(target.phases).map(object);
    requireShardEvidence(phases.length === 1, 'one functional phase is required per target.');
    const phase = phases[0]!;
    requireShardEvidence(phase.phase === 'functional' && phase.target === target.target && phase.baseUrl === target.baseUrl
      && phase.result === 'passed' && phase.browserCleanup === 'passed', 'functional phase or browser cleanup did not pass.');
    const scenarios = shardScenarios(target.scenarios);
    const phaseScenarios = shardScenarios(phase.scenarios);
    aggregateScenarios([scenarios], required);
    aggregateScenarios([phaseScenarios], required);
    return { target: target.target as ShardTarget['target'], baseUrl: target.baseUrl, scenarios };
  });
  return verified;
};

const shardAuthentication = (value: unknown, current: number, targets: readonly ShardTarget[], githubSha: string): void => {
  const receipts = array(value).map(object);
  requireShardEvidence(receipts.length === (current === 2 ? 2 : 0), 'combined authentication belongs only to shard 2.');
  if (current === 1) return;
  requireShardEvidence(new Set(receipts.map(({ target }) => target)).size === 2, 'combined authentication target is duplicated.');
  for (const receipt of receipts) {
    const target = targets.find((candidate) => candidate.target === receipt.target);
    requireShardEvidence(target !== undefined && receipt.schemaVersion === 1 && receipt.kind === 'auth-combined'
      && receipt.sourceGitSha === githubSha && receipt.origin === target.baseUrl && receipt.result === 'passed'
      && receipt.cleanup === 'passed' && receipt.browserCleanup === 'passed', 'combined authentication source, target or cleanup differs.');
    const checks = array(receipt.checks).map(object);
    requireShardEvidence(checks.length === authCombinedChecks.length && authCombinedChecks.every((name) =>
      checks.filter((entry) => entry.name === name && entry.result === 'passed').length === 1), 'combined authentication checks are incomplete.');
    requireShardEvidence(validAdmittedRemoval(checks.find(entry => entry.name === 'admitted-member-removal')), 'combined grant lock evidence is incomplete.');
  }
};

export const validateShardEvidence = (receipts: readonly unknown[], githubSha: string, gitTreeSha: string): void => {
  requireShardEvidence(/^[a-f0-9]{40}$/.test(githubSha) && /^[a-f0-9]{40}$/.test(gitTreeSha), 'current checkout source is invalid.');
  requireShardEvidence(receipts.length === 2, 'exactly two shard receipts are required.');
  const shards = new Set<number>();
  const runs = new Set<string>();
  const targetScenarios: Record<ShardTarget['target'], Scenario[][]> = { native: [], container: [] };
  for (const raw of receipts) {
    const receipt = object(raw);
    const shard = object(receipt.shard);
    requireShardEvidence(shard.total === 2 && (shard.current === 1 || shard.current === 2), 'expected shard 1/2 or 2/2.');
    requireShardEvidence(!shards.has(shard.current), 'shard identity is duplicated.');
    shards.add(shard.current);
    requireShardEvidence(receipt.schemaVersion === 3 && receipt.mode === 'functional' && receipt.result === 'passed'
      && receipt.cleanup === 'passed', 'functional run or cleanup did not pass.');
    requireShardEvidence(typeof receipt.runId === 'string' && receipt.runId.length > 0 && !runs.has(receipt.runId), 'run identity is missing or duplicated.');
    runs.add(receipt.runId);
    const source = object(receipt.source);
    requireShardEvidence(source.gitSha === githubSha && source.githubSha === githubSha && source.dirty === false
      && source.gitTreeSha === gitTreeSha, 'source does not match the clean current checkout.');
    requireShardEvidence(object(receipt.native).cleanup === 'passed' && object(receipt.installedCli).cleanup === 'passed', 'native or installed CLI cleanup did not pass.');
    const selection = array(receipt.selection);
    requireShardEvidence(selection.length > 0 && new Set(selection).size === selection.length
      && selection.every((name) => typeof name === 'string' && (functionalScenarios as readonly string[]).includes(name)), 'selected inventory is invalid.');
    const targets = shardTargets(receipt.targets, selection as string[]);
    for (const target of targets) targetScenarios[target.target].push(target.scenarios);
    shardAuthentication(receipt.authCombined, shard.current, targets, githubSha);
  }
  for (const phases of Object.values(targetScenarios)) aggregateScenarios(phases, functionalScenarios);
};

const main = async (): Promise<void> => {
  if (process.argv.length !== 5 || process.argv[2] !== '--shards') throw new Error('Usage: node scripts/acceptance/report.mts --shards <receipt1> <receipt2>');
  const githubSha = process.env.GITHUB_SHA;
  if (githubSha === undefined) throw new Error('Shard verification requires GITHUB_SHA.');
  const receipts: unknown[] = await Promise.all(process.argv.slice(3).map(async (path) => JSON.parse(await readFile(path, 'utf8')) as unknown));
  const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD', 'HEAD^{tree}'], { timeout: 10_000 });
  const source = stdout.trim().split('\n');
  requireShardEvidence(source.length === 2 && source[0] === githubSha, 'GITHUB_SHA does not match the current checkout.');
  validateShardEvidence(receipts, githubSha, source[1]!);
  console.log('Both Web shards passed the complete functional and authentication inventory.');
};

if (import.meta.main) {
  try { await main(); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
