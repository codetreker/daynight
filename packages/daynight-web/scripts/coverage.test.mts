import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeCoverage, checkCoverage, classifySourceFiles, hasRuntimeJavaScript, requireCoverageAbove90 } from './coverage.mts';

const script = fileURLToPath(new URL('./coverage.mts', import.meta.url));
const temporaryRoot = fileURLToPath(new URL('../.tmp/', import.meta.url));
type Entry = { path: string; statementMap: Record<string, unknown>; s: Record<string, unknown> };

const entry = (path: string, hits: number[] = [1]): Entry => ({
  path,
  statementMap: Object.fromEntries(hits.map((_, index) => [String(index), {
    start: { line: 1, column: index }, end: { line: 1, column: index + 1 },
  }])),
  s: Object.fromEntries(hits.map((hit, index) => [String(index), hit])),
});

const fixture = async (run: (directory: string, source: (path: string, text?: string) => Promise<string>) => Promise<void>): Promise<void> => {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'coverage-test-'));
  const source = async (path: string, text = 'export const value = 1;\n'): Promise<string> => {
    const destination = join(directory, 'src', path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, text);
    return destination;
  };
  try { await run(directory, source); }
  finally { await rm(directory, { recursive: true, force: true }); }
};

test('counts all nested product statements exactly and ignores nonproduct entries', async () => {
  await fixture(async (directory, source) => {
    const first = await source('main.ts');
    await source('nested/view.tsx', 'export const view = <p>Task</p>;');
    const declaration = await source('types.d.ts', 'export interface Task { title: string }');
    const result = await analyzeCoverage({
      [first]: entry(first, [1, 0]),
      'src/nested/view.tsx': entry('src/nested/view.tsx', Array(9).fill(2)),
      [declaration]: entry(declaration, []),
      'tests/app.test.ts': entry('tests/app.test.ts', Array(100).fill(0)),
      'node_modules/library/index.ts': entry('node_modules/library/index.ts', [0]),
      'dist/app.ts': entry('dist/app.ts', [0]),
    }, directory);
    assert.equal(result.covered, 10n);
    assert.equal(result.total, 11n);
    assert.deepEqual(result.files.map(({ path, runtime }) => ({ path, runtime })), [
      { path: 'src/main.ts', runtime: true },
      { path: 'src/nested/view.tsx', runtime: true },
      { path: 'src/types.d.ts', runtime: false },
    ]);
    assert.doesNotThrow(() => requireCoverageAbove90(result));
  });
});

test('strict threshold rejects exactly 90%, values that round to 90.0%, and invalid totals', () => {
  for (const covered of [0n, 89999n, 90000n]) {
    assert.throws(() => requireCoverageAbove90({ covered, total: 100000n }), />90%/);
  }
  for (const [covered, total] of [[0n, 0n], [-1n, 10n], [11n, 10n]] as const) {
    assert.throws(() => requireCoverageAbove90({ covered, total }), /Invalid coverage totals/);
  }
  for (const [covered, total] of [[10n, 11n], [90001n, 100000n], [10n ** 30n, 10n ** 30n + 1n]] as const) {
    assert.doesNotThrow(() => requireCoverageAbove90({ covered, total }));
  }
});

test('requires unimported runtime source regardless of its name', async () => {
  await fixture(async (directory, source) => {
    const main = await source('main.ts');
    for (const filename of ['unimported.ts', 'unused.test.ts', 'unused.spec.tsx', '__tests__/runtime.ts']) {
      const extra = await source(filename);
      await assert.rejects(analyzeCoverage({ [main]: entry(main) }, directory), /missing runtime product source/);
      await rm(extra);
    }
  });
});

test('classifies type-only files from native emitted JavaScript including ambient declarations', async () => {
  await fixture(async (directory) => {
    const examples = [
      ['types.ts', 'export type Status = "todo" | "done"; export interface Task { title: string }', false],
      ['interface.ts', 'interface Task { title: string }; export {};', false],
      ['import.ts', 'import type { Task } from "./task"; export type { Task };', false],
      ['nested/types.d.ts', 'export declare const value: string; declare namespace Tasks { interface Task {} }', false],
      ['empty.ts', '// No executable declarations.\n', false],
      ['runtime.d.ts', 'export const value = 1;', true],
      ['runtime.d.ts.ts', 'export const other = 1;', true],
      ['startup.ts', 'import "./start";', true],
      ['reexport.ts', 'export { value } from "./value";', true],
      ['view.tsx', 'export const view = <p>Task</p>;', true],
      ['class.ts', 'export class Task {}', true],
      ['enum.ts', 'export const enum Status { Todo }', true],
    ] as const;
    const sources = examples.map(([filename, text]) => ({ path: join(directory, 'src', filename), text }));
    const classifications = await classifySourceFiles(sources, directory);
    for (const [filename, , runtime] of examples) assert.equal(classifications.get(join(directory, 'src', filename)), runtime, filename);
    await assert.rejects(classifySourceFiles([{ path: join(directory, 'src/broken.ts'), text: 'export const = ;' }], directory), /Cannot emit product source/);
  });
});

test('emitted JavaScript scanner ignores only comments, empty statements, and module markers', () => {
  for (const javascript of ['', '// empty\n', ';\n;', 'export {};', '/* marker */ export { };\n;export {};']) {
    assert.equal(hasRuntimeJavaScript(javascript), false, javascript);
  }
  for (const javascript of ['export {} from "./module";', 'export { value };', 'import "./start";', '"export {};";', 'export const x = 1;', 'export {', 'export {}\nconst x = 1;']) {
    assert.equal(hasRuntimeJavaScript(javascript), true, javascript);
  }
});

test('allows missing coverage only for independently verified type-only source', async () => {
  await fixture(async (directory, source) => {
    const main = await source('main.ts');
    await source('types.ts', 'export interface Task { title: string }');
    const report = { [main]: entry(main) };
    const result = await analyzeCoverage(report, directory);
    assert.deepEqual(result.files[1], { path: 'src/types.ts', runtime: false, covered: 0n, total: 0n });
    await source('types.ts', 'export const title = "Task";');
    await assert.rejects(analyzeCoverage(report, directory), /missing runtime product source/);
  });
});

test('rejects empty source manifests and zero statement totals', async () => {
  await fixture(async (directory, source) => {
    await mkdir(join(directory, 'src'));
    await assert.rejects(analyzeCoverage({}, directory), /no TypeScript files/);
    const types = await source('types.ts', 'export type Status = "todo";');
    await assert.rejects(analyzeCoverage({}, directory), /no product statements/);
    await assert.rejects(analyzeCoverage({ [types]: entry(types, []) }, directory), /no product statements/);
    const main = await source('main.ts');
    await assert.rejects(analyzeCoverage({ [main]: entry(main, []) }, directory), /Runtime product source has no statements/);
    await assert.rejects(analyzeCoverage({ [main]: entry(main), [types]: entry(types) }, directory), /Type-only product source has runtime statements/);
  });
});

test('rejects invalid reports, missing entries, mismatched paths, and duplicate identities', async () => {
  await fixture(async (directory, source) => {
    const main = await source('main.ts');
    for (const report of [null, [], 'coverage', {}, { [main]: null }, { [main]: [] }]) {
      await assert.rejects(analyzeCoverage(report, directory));
    }
    for (const path of ['', null, 4]) {
      await assert.rejects(analyzeCoverage({ [main]: { ...entry(main), path } }, directory), /invalid path/);
    }
    await assert.rejects(analyzeCoverage({ '': entry(main) }, directory), /invalid path/);
    await assert.rejects(analyzeCoverage({ [main]: entry(join(directory, 'src/other.ts')) }, directory), /disagree/);
    await assert.rejects(analyzeCoverage({ [main]: entry(main), 'src/main.ts': entry('src/main.ts') }, directory), /Duplicate coverage identity/);
    const result = await analyzeCoverage({ 'src/../src/main.ts': entry('src/main.ts') }, directory);
    assert.equal(result.total, 1n);
  });
});

test('rejects missing, extra, and malformed statement IDs or counters', async () => {
  await fixture(async (directory, source) => {
    const main = await source('main.ts');
    for (const malformed of [
      { ...entry(main), statementMap: null },
      { ...entry(main), statementMap: [] },
      { ...entry(main), s: null },
      { ...entry(main), s: [] },
      { ...entry(main), s: {} },
      { ...entry(main), s: { 0: 1, 1: 1 } },
      { ...entry(main), statementMap: { invalid: entry(main).statementMap['0'] }, s: { invalid: 1 } },
      { ...entry(main), statementMap: { '01': entry(main).statementMap['0'] }, s: { '01': 1 } },
      ...[-1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null].map((hit) => ({ ...entry(main), s: { 0: hit } })),
    ]) await assert.rejects(analyzeCoverage({ [main]: malformed }, directory));
    const result = await analyzeCoverage({ [main]: entry(main, [Number.MAX_SAFE_INTEGER, 0]) }, directory);
    assert.equal(result.covered, 1n);
  });
});

test('rejects malformed statement locations and reversed ranges', async () => {
  await fixture(async (directory, source) => {
    const main = await source('main.ts');
    for (const statement of [
      null, [], {},
      { start: { line: 0, column: 0 }, end: { line: 1, column: 1 } },
      { start: { line: 1, column: -1 }, end: { line: 1, column: 1 } },
      { start: { line: 1, column: null }, end: { line: 1, column: 1 } },
      { start: { line: 1.2, column: 0 }, end: { line: 1, column: 1 } },
      { start: { line: 1, column: 0 }, end: { line: null, column: 1 } },
      { start: { line: 1, column: 0 }, end: { line: 1 } },
      { start: { line: 1, column: 0 }, end: { line: 1, column: Infinity } },
      { start: { line: 1, column: 0 }, end: { line: 0, column: 1 } },
      { start: { line: 2, column: 0 }, end: { line: 1, column: 1 } },
      { start: { line: 1, column: 2 }, end: { line: 1, column: 1 } },
    ]) {
      const malformed = { ...entry(main), statementMap: { 0: statement } };
      await assert.rejects(analyzeCoverage({ [main]: malformed }, directory));
    }
  });
});

test('accepts only the provider JSON null end-column sentinel for an unbounded line end', async () => {
  await fixture(async (directory, source) => {
    const main = await source('main.ts');
    const report = { [main]: {
      ...entry(main),
      statementMap: { 0: { start: { line: 1, column: 18 }, end: { line: 1, column: null } } },
    } };
    const result = await analyzeCoverage(report, directory);
    assert.equal(result.covered, 1n);
    assert.equal(result.total, 1n);
    report[main]!.statementMap['0']!.end.line = 0;
    await assert.rejects(analyzeCoverage(report, directory), /safe integer/);
    report[main]!.statementMap['0']!.start.line = 2;
    report[main]!.statementMap['0']!.end.line = 1;
    await assert.rejects(analyzeCoverage(report, directory), /Invalid statement range/);
  });
});

test('reads JSON reports and exposes invalid JSON and missing files', async () => {
  await fixture(async (directory, source) => {
    const main = await source('main.ts');
    const report = join(directory, 'coverage.json');
    await writeFile(report, JSON.stringify({ [main]: entry(main) }));
    assert.equal((await checkCoverage(report, directory)).total, 1n);
    assert.equal((await checkCoverage('coverage.json', directory)).total, 1n);
    await writeFile(report, '{');
    await assert.rejects(checkCoverage(report, directory), SyntaxError);
    await assert.rejects(checkCoverage(join(directory, 'missing.json'), directory), /ENOENT/);
  });
});

test('CLI validates the default report, records relative manifests, and fails strict boundaries', async () => {
  await fixture(async (directory, source) => {
    const main = await source('main.ts');
    const report = join(directory, '.tmp/coverage/coverage-final.json');
    const receipt = join(directory, '.tmp/coverage/summary.json');
    await mkdir(dirname(report), { recursive: true });
    const run = (args: string[] = []) => {
      const result = spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: 'utf8', timeout: 10000 });
      assert.ifError(result.error);
      return result;
    };
    await writeFile(report, JSON.stringify({ [main]: entry(main, [...Array(10).fill(1), 0]) }));
    const success = run();
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /10\/11 statements across 1 product files/);
    const summary = JSON.parse(await readFile(receipt, 'utf8'));
    assert.deepEqual(summary, {
      covered: '10', total: '11',
      files: [{ path: 'src/main.ts', runtime: true, covered: '10', total: '11' }], result: 'passed',
    });
    await writeFile(report, JSON.stringify({ [main]: entry(main, [...Array(9).fill(1), 0]) }));
    const boundary = run([report]);
    assert.equal(boundary.status, 1);
    assert.match(boundary.stderr, />90%/);
    assert.equal(JSON.parse(await readFile(receipt, 'utf8')).result, 'failed');
    await writeFile(report, '{}');
    const missing = run(['.tmp/coverage/coverage-final.json']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /missing runtime product source/);
    await assert.rejects(readFile(receipt), /ENOENT/);
    assert.equal(run(['missing.json']).status, 1);
    const usage = run(['first', 'second']);
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /Usage:/);
  });
});
