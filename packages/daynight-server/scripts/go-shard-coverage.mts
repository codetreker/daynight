import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { planPackages, shardNames } from './go-shard-plan.mts';

type CoverageBlock = { statements: string; count: bigint };

const profileRow = /^(.+):([1-9]\d*)\.([1-9]\d*),([1-9]\d*)\.([1-9]\d*) (0|[1-9]\d*) (0|[1-9]\d*)$/;

const fileLines = (filename: string) => createInterface({
  input: createReadStream(filename, { encoding: 'utf8' }), crlfDelay: Infinity,
});

export const mergeAtomicProfiles = async (
  inputs: string[], output: string, coverPackages?: ReadonlySet<string>,
): Promise<void> => {
  const blocks = new Map<string, CoverageBlock>();
  for (const filename of inputs) {
    let lineNumber = 0;
    for await (const line of fileLines(filename)) {
      lineNumber++;
      if (lineNumber === 1) {
        if (line !== 'mode: atomic') throw new Error(`Invalid atomic coverage mode in ${filename}.`);
        continue;
      }
      const row = profileRow.exec(line);
      if (row === null) throw new Error(`Invalid coverage row ${lineNumber} in ${filename}.`);
      const [, file, fromLine, fromColumn, toLine, toColumn, statements, seen] = row;
      if (Number(toLine) < Number(fromLine) || (toLine === fromLine && Number(toColumn) < Number(fromColumn))) {
        throw new Error(`Invalid coverage block position in row ${lineNumber} in ${filename}.`);
      }
      if (coverPackages !== undefined && !coverPackages.has(dirname(file))) {
        throw new Error(`Coverage source ${file} is outside the module coverage partition.`);
      }
      const key = `${file}:${fromLine}.${fromColumn},${toLine}.${toColumn}`;
      const previous = blocks.get(key);
      if (previous !== undefined) {
        if (previous.statements !== statements) throw new Error(`Conflicting coverage statement counts at ${key}.`);
        if (seen !== '0') previous.count += BigInt(seen);
      } else {
        blocks.set(key, { statements, count: BigInt(seen) });
      }
    }
    if (lineNumber < 2) throw new Error(`Empty Go coverage profile ${filename}.`);
  }
  writeFileSync(output, 'mode: atomic\n' + Array.from(blocks, ([key, { statements, count }]) =>
    `${key} ${statements} ${count}\n`).join(''));
};

const jsonFrom = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

const requireFinalNewline = (path: string, size: number) => {
  const descriptor = openSync(path, 'r');
  try {
    const final = Buffer.alloc(1);
    if (readSync(descriptor, final, 0, 1, size - 1) !== 1 || final[0] !== 10) {
      throw new Error(`Unterminated Go test capture in ${path}.`);
    }
  } finally {
    closeSync(descriptor);
  }
};

const samePackages = (actual: unknown, expected: string[]): boolean => {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const received = [...actual].sort();
  return [...expected].sort().every((name, index) => name === received[index]);
};

export const validateShard = async (
  directory: string,
  shard: string,
  source: string,
  race: boolean,
  packages: string[],
  testPackages: ReadonlySet<string>,
): Promise<string> => {
  const receipt = jsonFrom(join(directory, 'receipt.json'));
  if (receipt.version !== 1 || receipt.shard !== shard || receipt.source !== source ||
      receipt.race !== race || !samePackages(receipt.packages, packages)) {
    throw new Error(`Invalid source, race mode, or package assignment for Go shard ${shard}.`);
  }

  if (existsSync(join(directory, 'go-test.failed.json'))) {
    throw new Error(`Go shard ${shard} recorded a test capture failure.`);
  }
  const completion = jsonFrom(join(directory, 'go-test.complete.json'));
  const events = join(directory, 'go-test.jsonl');
  if (completion.version !== 1 || completion.exitCode !== 0 || completion.signal !== null ||
      !Number.isSafeInteger(completion.bytes) || completion.bytes < 1 ||
      statSync(events).size !== completion.bytes) {
    throw new Error(`Incomplete Go test capture for shard ${shard}.`);
  }
  requireFinalNewline(events, completion.bytes);

  const expected = new Set(packages);
  const finished = new Set<string>();
  for await (const line of fileLines(events)) {
    const event = JSON.parse(line);
    if (event.Action === 'build-output' && event.Package === undefined && !event.Test) continue;
    if (event.Action === 'fail' || event.Action === 'build-fail' || typeof event.Action !== 'string' ||
        !expected.has(event.Package)) {
      throw new Error(`Failed or unexpected test event for ${String(event.Package)} in Go shard ${shard}.`);
    }
    if (event.Action === 'output' && !event.Test && typeof event.Output === 'string' &&
        /^ok\s+\S+\s+\(cached\)/.test(event.Output)) {
      throw new Error(`Cached package result for ${event.Package} in Go shard ${shard}.`);
    }
    if (!event.Test && (event.Action === 'pass' || event.Action === 'skip')) {
      if (finished.has(event.Package) || (event.Action === 'skip' && testPackages.has(event.Package))) {
        throw new Error(`Duplicate or unexpected ${event.Action} for ${event.Package} in Go shard ${shard}.`);
      }
      finished.add(event.Package);
    }
  }
  const missing = packages.filter(pkg => !finished.has(pkg));
  if (missing.length !== 0) throw new Error(`Missing package results in Go shard ${shard}: ${missing.join(', ')}.`);
  return events;
};

type Replay = {
  testArgs: string[];
  paths: string[];
  merged: string;
  profile: string;
  invoked: string;
};

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

const replay = async (manifest: string, args: string[]): Promise<void> => {
  const spec = jsonFrom(manifest) as Replay;
  if (spec.testArgs.length !== args.length || spec.testArgs.some((arg, index) => arg !== args[index])) {
    throw new Error('The pinned go-cov requested an unexpected test invocation.');
  }
  writeFileSync(spec.invoked, '', { flag: 'wx' });
  copyFileSync(spec.merged, spec.profile);
  for (const file of spec.paths) {
    for await (const chunk of createReadStream(file)) {
      await new Promise<void>((complete, reject) => {
        process.stdout.write(chunk, error => { if (error) reject(error); else complete(); });
      });
    }
  }
};

type Discovery = { name: string; production: boolean; tests: boolean };

const discoverPackages = (go: string): Discovery[] => {
  const template = '{{.ImportPath}} {{if or .GoFiles .CgoFiles}}yes{{else}}no{{end}} {{if or .TestGoFiles .XTestGoFiles}}yes{{else}}no{{end}}';
  return execFileSync(go, ['list', '-f', template, './...'], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const [name, production, tests, extra] = line.split(' ');
    if (name === '' || !['yes', 'no'].includes(production) || !['yes', 'no'].includes(tests) || extra !== undefined) {
      throw new Error(`Invalid Go package discovery row ${line}.`);
    }
    return { name, production: production === 'yes', tests: tests === 'yes' };
  });
};

const report = async (artifacts: string, raceMode: string, go: string, goCov: string): Promise<void> => {
  if (!['true', 'false'].includes(raceMode) || ![artifacts, go, goCov].every(isAbsolute)) {
    throw new Error('Expected absolute artifact and tool paths and the selected Go race mode.');
  }
  const race = raceMode === 'true';
  const modulePath = execFileSync(go, ['list', '-m'], { encoding: 'utf8' }).trim();
  const discovered = discoverPackages(go);
  const command = `${modulePath}/cmd/daynight-server`;
  const plan = planPackages(discovered.map(pkg => pkg.name), modulePath);
  const testPackages = new Set(discovered.filter(pkg => pkg.tests).map(pkg => pkg.name));
  const coverPackages = new Set(discovered.filter(pkg => pkg.production && pkg.name !== command).map(pkg => pkg.name));
  if (coverPackages.size === 0) throw new Error('Go discovery found no production coverage packages.');
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const paths = await Promise.all(shardNames.map(shard =>
    validateShard(join(artifacts, shard), shard, source, race, plan[shard], testPackages)));
  const directory = mkdtempSync(join(artifacts, '.report-'));
  const profile = resolve('coverage.out');
  try {
    const merged = join(directory, 'coverage.out');
    await mergeAtomicProfiles(shardNames.map(shard => join(artifacts, shard, 'coverage.out')), merged, coverPackages);
    const manifest = join(directory, 'replay.json');
    const invoked = join(directory, 'invoked');
    const packages = discovered.map(pkg => pkg.name).filter(pkg => pkg !== command);
    const testArgs = ['test', ...packages, '-json', '-covermode=atomic', `-coverprofile=${profile}`, '-timeout=10m'];
    if (race) testArgs.push('-race');
    writeFileSync(manifest, JSON.stringify({ testArgs, paths, merged, profile, invoked } satisfies Replay));
    const shimDirectory = join(directory, 'shim');
    mkdirSync(shimDirectory);
    writeFileSync(join(shimDirectory, 'go'), [
      '#!/bin/sh',
      // Validate go-cov's pinned test command and replay the real shard output.
      // All other commands still execute the actual Go tool.
      'if [ "$1" != test ]; then exec ' + shellQuote(go) + ' "$@"; fi',
      'exec ' + [process.execPath, fileURLToPath(import.meta.url), 'replay', manifest].map(shellQuote).join(' ') + ' "$@"',
      '',
    ].join('\n'), { mode: 0o700 });
    rmSync(profile, { force: true });
    console.log('Replaying verified test events from the completed Go shards for the coverage report.');
    const result = spawnSync(goCov, [`--race=${race}`, `--exclude-packages=${command}`, `--coverprofile=${profile}`], {
      stdio: 'inherit',
      env: { ...process.env, PATH: shimDirectory + delimiter + (process.env.PATH ?? '') },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`go-cov failed with ${result.signal ?? result.status}.`);
    if (!existsSync(invoked) || !existsSync(profile)) throw new Error('go-cov skipped the verified test replay.');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (mode === 'compact' && args.length === 2) await mergeAtomicProfiles([args[0]], args[1]);
    else if (mode === 'report' && args.length === 4) await report(args[0], args[1], args[2], args[3]);
    else if (mode === 'replay' && args.length > 1) await replay(args[0], args.slice(1));
    else throw new Error('Expected compact INPUT OUTPUT or report ARTIFACTS RACE GO GO_COV.');
  } catch (error) {
    process.exitCode = 1;
    console.error('Go shard coverage failed:', error);
  }
}
