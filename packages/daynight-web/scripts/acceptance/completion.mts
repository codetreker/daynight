import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { aggregateScenarios, type Scenario } from './report.mts';
import { validatePerformance } from './performance.mts';
import { validateAuthCombinedResult, type AuthCombinedResult } from './auth-combined-report.mts';
import { capacityScenarios, expectedTargets, functionalScenarios, readAcceptanceScope, type AcceptanceScope, type AcceptanceTarget } from './inventory.mts';
import { nativeEvidence, type Evidence, type Source } from './evidence.mts';

type BrowserIdentity = { name: string; version: string; platform: string; executableOverride: boolean };
type CompletedPhase = { phase: 'functional' | 'capacity'; startedAt: string; finishedAt: string; browser: BrowserIdentity; scenarios: Scenario[] };
type CompletedStage = { name: string; startedAt: string; finishedAt: string };
type NativeRuntime = { kind: 'native'; binarySha256: string; postgresImageId: string; postgresVersion: string };
type ContainerRuntime = { kind: 'container'; imageId: string; runId: string; containerIds: string[] };
type CompletedTarget = { target: AcceptanceTarget; baseUrl: string; phases: CompletedPhase[]; authCombined: AuthCombinedResult; runtime: NativeRuntime | ContainerRuntime };
export type CompletionFile = { path: string; sha256: string; size: number };
export type AcceptanceCompletion = {
  schemaVersion: 1; scope: AcceptanceScope; runId: string; source: Source; result: 'passed'; cleanup: 'passed';
  startedAt: string; finishedAt: string;
  installedCli: { packageVersion: string; tarballSha256: string; entrySha256: string };
  targets: CompletedTarget[]; stages: CompletedStage[]; files: CompletionFile[]; performance?: unknown;
};
export type CompletionExpectation = { scope: AcceptanceScope; source: Source; platform: string; ci: boolean };
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const check: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) throw new Error(message); };
const object = (value: unknown): Record<string, unknown> => {
  check(typeof value === 'object' && value !== null && !Array.isArray(value), 'Invalid acceptance completion object.');
  return value as Record<string, unknown>;
};
const filePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && !/[\\\p{Cc}]/u.test(value) && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
const browserIdentity = (value: unknown): BrowserIdentity => {
  const browser = object(value);
  check(browser.name === 'chromium' && typeof browser.version === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(browser.version)
    && ['linux', 'darwin'].includes(String(browser.platform)) && typeof browser.executableOverride === 'boolean', 'Invalid completion browser identity.');
  return { name: browser.name, version: browser.version, platform: browser.platform as string, executableOverride: browser.executableOverride };
};
const relativeFile = (directory: string, path: string): string => {
  const result = relative(directory, resolve(path)).split(sep).join('/');
  check(filePath(result), 'Completion evidence lies outside its acceptance directory.');
  return result;
};

export const validateAcceptanceCompletion = (value: unknown, expected: CompletionExpectation): AcceptanceCompletion => {
  object(value);
  const receipt = value as AcceptanceCompletion;
  check(receipt.schemaVersion === 1 && readAcceptanceScope(receipt.scope) === expected.scope
    && /^\d{14}-[a-f0-9-]{36}$/.test(receipt.runId) && receipt.result === 'passed' && receipt.cleanup === 'passed', 'Acceptance completion scope or result differs.');
  const source = object(receipt.source);
  check(/^[a-f0-9]{40}$/.test(String(source.gitSha)) && /^[a-f0-9]{40}$/.test(String(source.gitTreeSha))
    && typeof source.dirty === 'boolean' && (source.githubSha === null || /^[a-f0-9]{40}$/.test(String(source.githubSha)))
    && source.gitSha === expected.source.gitSha && source.gitTreeSha === expected.source.gitTreeSha
    && source.dirty === expected.source.dirty && source.githubSha === expected.source.githubSha
    && (!expected.ci || (!source.dirty && source.githubSha === source.gitSha)), 'Acceptance completion source differs.');
  check(typeof receipt.startedAt === 'string' && typeof receipt.finishedAt === 'string'
    && Number.isFinite(Date.parse(receipt.startedAt)) && Number.isFinite(Date.parse(receipt.finishedAt))
    && Date.parse(receipt.finishedAt) >= Date.parse(receipt.startedAt), 'Acceptance completion timing is invalid.');
  const installed = object(receipt.installedCli);
  check(typeof installed.packageVersion === 'string' && installed.packageVersion !== ''
    && /^[a-f0-9]{64}$/.test(String(installed.tarballSha256)) && /^[a-f0-9]{64}$/.test(String(installed.entrySha256)), 'Acceptance completion CLI identity is invalid.');
  check(Array.isArray(receipt.files) && receipt.files.length > 0, 'Acceptance completion files are missing.');
  const files = new Set<string>();
  for (const raw of receipt.files) {
    const file = object(raw);
    check(filePath(file.path) && !files.has(file.path) && /^[a-f0-9]{64}$/.test(String(file.sha256))
      && Number.isSafeInteger(file.size) && Number(file.size) >= 0, 'Acceptance completion file identity is invalid.');
    files.add(file.path);
  }
  const requireFile = (path: string): void => { check(files.has(path), `Acceptance completion is missing ${path}.`); };
  const requirePictures = (pictures: unknown, prefix: string): void => {
    check(Array.isArray(pictures) && pictures.length > 0, 'Completion screenshot evidence is missing.');
    for (const picture of pictures) {
      check(filePath(picture) && picture.startsWith(prefix) && picture.endsWith('.png'), 'Completion screenshot path differs from its phase.');
      requireFile(picture);
    }
  };
  const required = expectedTargets(receipt.scope);
  const requiredStages = receipt.scope === 'all' ? ['native-preparation', 'native-functional', 'container-release', 'container', 'native-capacity']
    : receipt.scope === 'native' ? ['native-preparation', 'native-functional', 'native-capacity'] : ['cli-preparation', 'container'];
  check(Array.isArray(receipt.stages) && receipt.stages.length === requiredStages.length, 'Acceptance completion stage inventory differs.');
  const stages = new Map<string, CompletedStage>();
  const timestamps = (startedAt: string, finishedAt: string): void => {
    check(typeof startedAt === 'string' && typeof finishedAt === 'string' && Number.isFinite(Date.parse(startedAt))
      && Number.isFinite(Date.parse(finishedAt)) && Date.parse(startedAt) <= Date.parse(finishedAt), 'Completion stage timing is invalid.');
  };
  for (const stage of receipt.stages) {
    check(requiredStages.includes(stage.name) && !stages.has(stage.name), 'Completion stage is unexpected or duplicated.');
    timestamps(stage.startedAt, stage.finishedAt);
    stages.set(stage.name, stage);
  }
  const before = (earlier: string, later: string): void => {
    check(Date.parse(stages.get(earlier)!.finishedAt) <= Date.parse(stages.get(later)!.startedAt), 'Completion phase ordering or isolation differs.');
  };
  if (receipt.scope === 'container') before('cli-preparation', 'container');
  else {
    before('native-preparation', 'native-functional');
    before('native-functional', 'native-capacity');
    if (receipt.scope === 'all') {
      before('native-functional', 'container-release');
      before('container', 'native-capacity');
    }
  }

  check(Array.isArray(receipt.targets) && receipt.targets.length === required.length, 'Acceptance completion target inventory differs.');
  let originalBrowser: BrowserIdentity | undefined;
  for (const name of required) {
    const targets = receipt.targets.filter((entry) => entry.target === name);
    check(targets.length === 1, 'Acceptance completion target is missing or duplicated.');
    const target = targets[0]!;
    check(typeof target.baseUrl === 'string' && /^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(target.baseUrl), 'Acceptance completion target origin is invalid.');
    const requiredPhases = name === 'native' ? ['functional', 'capacity'] : ['functional'];
    check(Array.isArray(target.phases) && target.phases.length === requiredPhases.length, 'Acceptance completion phase inventory differs.');
    for (const phaseName of requiredPhases) {
      const phases = target.phases.filter((entry) => entry.phase === phaseName);
      check(phases.length === 1, 'Acceptance completion phase is missing or duplicated.');
      const phase = phases[0]!;
      timestamps(phase.startedAt, phase.finishedAt);
      const stage = stages.get(name === 'container' ? 'container' : `native-${phaseName === 'capacity' ? 'capacity' : 'functional'}`)!;
      check(Date.parse(stage.startedAt) <= Date.parse(phase.startedAt) && Date.parse(phase.finishedAt) <= Date.parse(stage.finishedAt), 'Completion browser timing lies outside its owning stage.');
      if (name === 'container' && receipt.scope === 'all') check(Date.parse(stages.get('native-functional')!.finishedAt) <= Date.parse(phase.startedAt), 'Container browser ran before native recovery completed.');

      const browser = browserIdentity(phase.browser);
      check(browser.platform === expected.platform && (!expected.ci || !browser.executableOverride), 'Acceptance completion browser platform or override differs.');
      if (originalBrowser === undefined) originalBrowser = browser;
      else check(JSON.stringify(browser) === JSON.stringify(originalBrowser), 'Browser identity changed between acceptance targets or phases.');
      check(Array.isArray(phase.scenarios), 'Acceptance completion scenarios are missing.');
      aggregateScenarios([phase.scenarios], phaseName === 'capacity' ? capacityScenarios : functionalScenarios);
      const prefix = name === 'native' ? `native/${phaseName}/` : 'container/';
      requireFile(`${prefix}playwright.json`);
      requireFile(`${prefix}target.json`);
      requireFile(`${prefix}browser.json`);
      for (const scenario of phase.scenarios) {
        check(typeof scenario.title === 'string' && scenario.title !== '' && Number.isFinite(scenario.durationMs) && scenario.durationMs >= 0, 'Completion scenario metadata is invalid.');
        requirePictures(scenario.screenshots, prefix);
      }
    }
    const auth = validateAuthCombinedResult(target.authCombined, { target: name, baseUrl: target.baseUrl, sourceGitSha: expected.source.gitSha }, expected.platform, expected.ci);
    check(auth.finishedAt !== undefined, 'Combined completion time is missing.');
    timestamps(auth.startedAt, auth.finishedAt);
    const authStage = stages.get(name === 'native' ? 'native-functional' : 'container')!;
    check(Date.parse(target.phases.find((phase) => phase.phase === 'functional')!.finishedAt) <= Date.parse(auth.startedAt)
      && Date.parse(auth.finishedAt) <= Date.parse(authStage.finishedAt), 'Combined completion lies outside its owning stage.');

    check(auth.installedCli.version === installed.packageVersion && auth.installedCli.tarballSha256 === installed.tarballSha256
      && auth.installedCli.entrySha256 === installed.entrySha256 && JSON.stringify(browserIdentity(auth.browser)) === JSON.stringify(originalBrowser), 'Combined completion CLI or browser identity differs.');
    requirePictures(auth.screenshots, `${name}/auth-combined/`);
    requireFile(`${name}/auth-combined/target.json`);
    const runtime = object(target.runtime);
    if (name === 'native') {
      check(runtime.kind === 'native' && /^[a-f0-9]{64}$/.test(String(runtime.binarySha256))
        && /^sha256:[a-f0-9]{64}$/.test(String(runtime.postgresImageId)) && /^postgres \(PostgreSQL\) 18\.6(?:\s|$)/.test(String(runtime.postgresVersion))
        && auth.restart?.binaryOrImage === runtime.binarySha256, 'Native completion runtime identity differs.');
    } else {
      check(runtime.kind === 'container' && /^sha256:[a-f0-9]{64}$/.test(String(runtime.imageId)) && /^\d{14}-\d+-\d{5}$/.test(String(runtime.runId))
        && Array.isArray(runtime.containerIds) && runtime.containerIds.every((id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))
        && typeof auth.restart?.containerId === 'string' && runtime.containerIds.includes(auth.restart.containerId)
        && auth.restart.binaryOrImage === runtime.imageId, 'Container completion runtime identity differs.');
    }

  }
  if (required.includes('native')) {
    validatePerformance(receipt.performance);
    requireFile('native/capacity/performance.json');
    for (const kind of ['chain', 'merge', 'shared', 'external']) for (let repetition = 0; repetition < 5; repetition++) {
      const suffix = `/capacity-${kind}-repetition-${repetition}-chromium-trace.json`;
      check([...files].filter((path) => path.startsWith('native/capacity/') && path.endsWith(suffix)).length === 1, 'Completion capacity trace inventory differs.');
    }
  } else check(receipt.performance === undefined, 'Container completion cannot contain native capacity evidence.');
  return receipt;
};

const collectFiles = async (directory: string): Promise<CompletionFile[]> => {
  const files: CompletionFile[] = [];
  const visit = async (path: string): Promise<void> => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = join(path, entry.name);
      if (path === directory && entry.name === 'completion.json') continue;
      check(!entry.isSymbolicLink(), 'Acceptance completion cannot follow symbolic links.');
      if (entry.isDirectory()) await visit(child);
      else {
        check(entry.isFile(), 'Acceptance completion contains an unsupported file.');
        const bytes = await readFile(child);
        if (entry.name.endsWith('.png')) check(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Completion screenshot is not PNG evidence.');
        files.push({ path: relativeFile(directory, child), sha256: digest(bytes), size: bytes.length });
      }
    }
  };
  await visit(directory);
  return files;
};

export const recordAcceptanceCompletion = async (evidence: Evidence, directory: string): Promise<AcceptanceCompletion> => {
  check(evidence.result === 'passed' && evidence.cleanup === 'passed' && evidence.finishedAt !== undefined
    && evidence.installedCli?.cleanup === 'passed' && evidence.installedCli.receipt !== undefined, 'Cannot complete unfinished acceptance.');
  if (evidence.scope !== 'container') check(nativeEvidence(evidence).cleanup === 'passed', 'Cannot complete uncleaned native acceptance.');
  const required = expectedTargets(evidence.scope);
  check(evidence.targets.length === required.length && required.every((name) => evidence.targets.filter((target) => target.target === name).length === 1)
    && evidence.authCombined?.length === required.length && required.every((name) => evidence.authCombined!.filter((target) => target.target === name).length === 1), 'Cannot complete an incomplete or duplicated target inventory.');

  const targets: CompletedTarget[] = required.map((name) => {
    const target = evidence.targets.find((entry) => entry.target === name);
    check(target !== undefined && target.result === 'passed', 'Cannot complete a missing or failed target.');
    const combined = evidence.authCombined?.find((entry) => entry.target === name);
    check(combined !== undefined, 'Cannot complete a target without combined authentication.');
    const result: AuthCombinedResult = { schemaVersion: combined.schemaVersion, kind: combined.kind, target: combined.target,
      sourceGitSha: combined.sourceGitSha, origin: combined.origin, result: combined.result, startedAt: combined.startedAt,
      cleanup: combined.cleanup, browserCleanup: combined.browserCleanup, browser: browserIdentity(combined.browser),
      installedCli: { version: combined.installedCli.version, sourceGitSha: combined.installedCli.sourceGitSha,
        entrySha256: combined.installedCli.entrySha256, tarballSha256: combined.installedCli.tarballSha256 },
      checks: combined.checks.map(({ name, result }) => ({ name, result })), screenshots: combined.screenshots.map((path) => relativeFile(directory, path)),
      ...(combined.finishedAt === undefined ? {} : { finishedAt: combined.finishedAt }),
      ...(combined.restart === undefined ? {} : { restart: { target: combined.restart.target, origin: combined.restart.origin,
        startedAt: combined.restart.startedAt, readyAt: combined.restart.readyAt, before: { ...combined.restart.before }, after: { ...combined.restart.after },
        binaryOrImage: combined.restart.binaryOrImage, ...(combined.restart.containerId === undefined ? {} : { containerId: combined.restart.containerId }) } }),
    };
    let runtime: NativeRuntime | ContainerRuntime;
    if (name === 'native') {
      const native = nativeEvidence(evidence);
      check(native.binarySha256 !== undefined && native.postgresImageId !== undefined && native.postgresVersion !== undefined, 'Native runtime identity is incomplete.');
      runtime = { kind: 'native', binarySha256: native.binarySha256, postgresImageId: native.postgresImageId, postgresVersion: native.postgresVersion };
    } else {
      const container = object(evidence.container);
      check(container.result === 'passed' && container.cleanupResult === 'passed' && typeof container.imageId === 'string'
        && typeof container.runId === 'string' && Array.isArray(container.containerIds), 'Container runtime identity is incomplete.');
      runtime = { kind: 'container', imageId: container.imageId, runId: container.runId, containerIds: container.containerIds as string[] };
    }

    return { target: name, baseUrl: target.baseUrl, phases: target.phases.map((phase) => {
      check(phase.result === 'passed' && phase.browserCleanup === 'passed' && phase.scenarios !== undefined, 'Cannot complete an unfinished browser phase.');
      check(phase.finishedAt !== undefined, 'Browser phase completion time is missing.');
      return { phase: phase.phase, startedAt: phase.startedAt, finishedAt: phase.finishedAt, browser: browserIdentity(phase.browser), scenarios: phase.scenarios.map((scenario) => ({
        ...scenario, screenshots: scenario.screenshots.map((path) => relativeFile(directory, path)),
      })) };
    }), authCombined: result, runtime };
  });
  const installed = evidence.installedCli.receipt;
  const completion: AcceptanceCompletion = { schemaVersion: 1, scope: evidence.scope, runId: evidence.runId, source: evidence.source,
    result: 'passed', cleanup: 'passed', startedAt: evidence.startedAt, finishedAt: evidence.finishedAt,
    installedCli: { packageVersion: installed.packageVersion, tarballSha256: installed.tarballSha256, entrySha256: installed.entrySha256 },
    targets, stages: evidence.stages.map((stage) => {
      check(stage.result === 'passed' && stage.finishedAt !== undefined, 'Cannot complete an unfinished acceptance stage.');
      return { name: stage.name, startedAt: stage.startedAt, finishedAt: stage.finishedAt };
    }), files: await collectFiles(directory), ...(required.includes('native') ? { performance: evidence.performance } : {}) };
  validateAcceptanceCompletion(completion, { scope: evidence.scope, source: evidence.source, platform: process.platform, ci: Boolean(process.env.CI) });
  const path = join(directory, 'completion.json');
  await writeFile(`${path}.next`, `${JSON.stringify(completion, null, 2)}\n`);
  await rename(`${path}.next`, path);
  return completion;
};

export const verifyCompletionFiles = async (completion: AcceptanceCompletion, directory: string): Promise<void> => {
  for (const file of completion.files) {
    check(filePath(file.path), 'Invalid completion file path.');
    let path = resolve(directory);
    for (const part of file.path.split('/')) {
      path = join(path, part);
      const entry = await lstat(path);
      check(!entry.isSymbolicLink(), 'Completion file resolves through a symbolic link.');
    }
    const bytes = await readFile(path);
    check(bytes.length === file.size && digest(bytes) === file.sha256, 'Completion file size or digest differs.');
    if (file.path.endsWith('.png')) check(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Completion screenshot is not PNG evidence.');
  }
};
