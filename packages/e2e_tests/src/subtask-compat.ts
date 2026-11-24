import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runCommand } from './command.ts';
import { candidateHandoffHash, combinationCleanupConfirmed, compatibilityPlans, mixedCombinationPassed, recordStoppedSequence, recoveryCleanupConfirmed, recoveryPassed, repairArguments, runCombination, runCompatibilityPlans, workerCombinationPassed, type CombinationManifest, type CombinationResult, type RecoveryReceipt } from './subtask-compat-process.ts';
import { verifyCandidateArtifact } from './subtask-compat-artifact.ts';
import { revisionFingerprint } from './subtask-compat-source.ts';

const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
const inputPath = (value: string): string => path.resolve(invocationDirectory, value);
const knownOldCliIntegrity = 'sha512-T85y9vOcRHjHvjFImEoDpOs25JxQkfSOLkSbmwUgVZi8S/KsQnVx3EJ5+r6Q/vwoGEP64HIPKdNHdUOVxpDe9w==';
const knownOldCliGitHead = 'f5d73f3275c8e2774a588967a0fbdcd2a261c379';
const sha = /^[a-f0-9]{40}$/;

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runCommand('git', args, { cwd, timeoutMs: 30_000, onOutput: () => {} })).stdout.trimEnd();
}

async function sourceIdentity(directory: string, expected: string): Promise<void> {
  if (!sha.test(expected)) throw new Error('Source revisions must be complete lowercase commit IDs.');
  if (await git(directory, ['rev-parse', '--is-shallow-repository']) !== 'false') throw new Error(`Source is shallow: ${directory}`);
  if (await git(directory, ['rev-parse', 'HEAD']) !== expected) throw new Error(`Source HEAD does not match ${expected}: ${directory}`);
  const changes = await git(directory, ['status', '--porcelain=v1', '--untracked-files=normal']);
  // The runner and its tests are developed in the candidate checkout. Product
  // inputs still have to match the selected commit, including untracked files.
  const relevant = changes.split('\n').filter(Boolean).filter(line => /^(?:packages\/(?:daynight|daynight-web|daynight-server)\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|patches\/)/.test(line.slice(3)));
  if (relevant.length) throw new Error(`Product source contains uncommitted changes: ${directory}\n${relevant.join('\n')}`);
}

async function treeHash(directory: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (parent: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(parent, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = prefix + entry.name;
      const filename = path.join(parent, entry.name);
      if (entry.isDirectory()) await walk(filename, `${name}/`);
      else if (entry.isFile()) hash.update(name).update('\0').update(await readFile(filename)).update('\0');
      else throw new Error(`Web artifact contains a nonregular entry: ${filename}`);
    }
  };
  await walk(directory, '');
  return hash.digest('hex');
}

const options = {
  candidate: { type: 'string' },
  'candidate-sha': { type: 'string' },
  baseline: { type: 'string' },
  'baseline-sha': { type: 'string' },
  'baseline-web': { type: 'string' },
  'old-server': { type: 'string' },
  'old-server-sha256': { type: 'string' },
  'old-cli': { type: 'string' },
  'repair-sha': { type: 'string' },
  'repair-artifact': { type: 'string' },
  'repair-artifact-sha256': { type: 'string' },
  'auth-source': { type: 'string' },
  'check-inputs': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} as const;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const parsed = parseArgs({ args: args[0] === '--' ? args.slice(1) : args, options });
  if (parsed.values.help) {
    console.log('Usage: pnpm --filter @codetreker/daynight-e2e test:subtask-compat --candidate <checkout> --candidate-sha <sha> --baseline <checkout> --baseline-sha <sha> --baseline-web <dist> --old-server <binary> --old-server-sha256 <hash> --old-cli <0.72.0.tgz> --repair-sha <sha> --repair-artifact <binary> --repair-artifact-sha256 <hash> [--auth-source <checkout>] [--check-inputs]');
    return;
  }
  const required = ['candidate', 'candidate-sha', 'baseline', 'baseline-sha', 'baseline-web', 'old-server', 'old-server-sha256', 'old-cli', 'repair-sha', 'repair-artifact', 'repair-artifact-sha256'] as const;
  for (const name of required) if (!parsed.values[name]) throw new Error(`Missing --${name}. Use --help for the required inputs.`);
  const candidate = inputPath(parsed.values.candidate!);
  const baseline = inputPath(parsed.values.baseline!);
  const candidateSha = parsed.values['candidate-sha']!;
  const baselineSha = parsed.values['baseline-sha']!;
  const repair = { revision: parsed.values['repair-sha']!, artifact: inputPath(parsed.values['repair-artifact']!), sha256: parsed.values['repair-artifact-sha256']! };
  const repairArgs = repairArguments(repair);
  await sourceIdentity(candidate, candidateSha);
  await sourceIdentity(baseline, baselineSha);
  await git(candidate, ['merge-base', '--is-ancestor', baselineSha, candidateSha]);
  if (await git(candidate, ['rev-parse', '--verify', `${repair.revision}^{commit}`]) !== repair.revision) throw new Error('Repair revision does not identify a commit in the candidate repository.');
  const repairFile = await lstat(repair.artifact);
  if (!repairFile.isFile() || repairFile.isSymbolicLink() || createHash('sha256').update(await readFile(repair.artifact)).digest('hex') !== repair.sha256) throw new Error('Repair artifact does not match the supplied SHA-256.');
  const oldCli = await readFile(inputPath(parsed.values['old-cli']!));
  const oldCliIntegrity = `sha512-${createHash('sha512').update(oldCli).digest('base64')}`;
  if (oldCliIntegrity !== knownOldCliIntegrity) throw new Error('Old CLI tarball does not match the known npm 0.72.0 integrity.');
  const serverHash = createHash('sha256').update(await readFile(inputPath(parsed.values['old-server']!))).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(parsed.values['old-server-sha256']!) || serverHash !== parsed.values['old-server-sha256']) throw new Error('Old Server hash does not match the supplied SHA-256.');
  const buildInfo = (await runCommand('go', ['version', '-m', inputPath(parsed.values['old-server']!)], { cwd: invocationDirectory, timeoutMs: 30_000, onOutput: () => {} })).stdout;
  if (!buildInfo.includes('\tpath\tgithub.com/codetreker/daynight/packages/daynight-server/cmd/daynight-server\n') ||
      !buildInfo.includes(`\tbuild\tvcs.revision=${baselineSha}\n`) || !buildInfo.includes('\tbuild\tvcs.modified=false\n')) {
    throw new Error('Old Server Go build information does not identify a clean build from the baseline commit.');
  }
  const webPath = inputPath(parsed.values['baseline-web']!);
  await readFile(path.join(webPath, 'index.html'));
  const webHash = await treeHash(webPath);
  console.log(JSON.stringify({ candidate: candidateSha, baseline: baselineSha, repair: { revision: repair.revision, sha256: repair.sha256, provenance: 'pending recovery verification' }, oldCli: { version: '0.72.0', gitHead: knownOldCliGitHead, integrity: oldCliIntegrity }, oldServer: { sha256: serverHash, buildRevision: baselineSha, modified: false }, baselineWeb: { sha256: webHash, provenance: 'caller supplied' } }, null, 2));
  if (parsed.values['check-inputs']) return;
  const runnerRepository = path.resolve(import.meta.dirname, '../../..');
  if (candidate !== runnerRepository) throw new Error('The candidate must be the checkout containing this compatibility runner.');
  const reportDirectory = path.join(runnerRepository, '.tmp', 'product-e2e-compat', randomUUID());
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  await mkdir(path.join(reportDirectory, 'private'), { mode: 0o700 });
  const candidateArtifact = path.join(reportDirectory, 'private', 'candidate-server');
  const report: { candidate: string; baseline: string; combinations: Record<string, unknown>; recovery: Record<string, unknown>; status: string } = {
    candidate: candidateSha, baseline: baselineSha, combinations: {}, recovery: { status: 'not-run' }, status: 'running',
  };
  const save = async (): Promise<void> => {
    const filename = path.join(reportDirectory, 'report.json');
    await writeFile(`${filename}.tmp`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    await rename(`${filename}.tmp`, filename);
  };
  await save();
  console.log(`Compatibility report: ${reportDirectory}`);
  let repairFingerprint: string;
  try { repairFingerprint = await revisionFingerprint(runnerRepository, repair.revision, path.join(reportDirectory, 'private')); }
  catch (error) {
    report.recovery = { status: 'not-run', reason: 'repair-source-unverified', category: error instanceof Error ? error.name : 'unknown' };
    report.status = 'failed'; await save(); throw error;
  }
  type CandidateCombination = CombinationResult & { manifestPath?: string | null; manifest?: CombinationManifest };
  const verifiedCandidate = async (): Promise<{ hash: string; manifestPath: string; sourceFingerprint: string; baselineFingerprint: string } | undefined> => {
    const combination = report.combinations.candidate as CandidateCombination | undefined;
    const hash = combination ? candidateHandoffHash(combination, combination.manifest ?? null, candidateSha, baselineSha, candidateArtifact) : undefined;
    const sourceFingerprint = combination?.manifest?.artifacts?.sourceFingerprint;
    const baselineFingerprint = combination?.manifest?.baselineArtifacts?.sourceFingerprint;
    if (!hash || !combination?.manifestPath || !sourceFingerprint || !/^[a-f0-9]{64}$/.test(sourceFingerprint) || !baselineFingerprint || !/^[a-f0-9]{64}$/.test(baselineFingerprint) || !await verifyCandidateArtifact(candidateArtifact, hash, candidateSha, runnerRepository)) return undefined;
    return { hash, manifestPath: combination.manifestPath, sourceFingerprint, baselineFingerprint };
  };
  const plans = compatibilityPlans();
  const sequence = await runCompatibilityPlans(plans, async plan => {
    console.log(`Compatibility combination: ${plan.key}`);
    const candidateInput = plan.workerVariant === undefined ? undefined : await verifiedCandidate();
    if (plan.workerVariant !== undefined && candidateInput === undefined) {
      report.combinations[plan.key] = { status: 'not-run', reason: 'candidate-artifact-unverified' };
      await save(); return { kind: 'not-run' };
    }
    const runnerArgs = [path.join(import.meta.dirname, 'subtask-compat-run.ts'), '--server', plan.server, '--candidate-sha', candidateSha,
      '--baseline', baselineSha, '--baseline-source', baseline, '--baseline-web', webPath, '--old-server', inputPath(parsed.values['old-server']!),
      '--old-cli', inputPath(parsed.values['old-cli']!)];
    if (plan.key === 'candidate') runnerArgs.push('--candidate-artifact-out', candidateArtifact);
    if (plan.workerVariant !== undefined && candidateInput !== undefined) runnerArgs.push('--worker-variant', plan.workerVariant, '--candidate-artifact-in', candidateArtifact, '--candidate-artifact-sha256', candidateInput.hash, '--candidate-manifest', candidateInput.manifestPath);
    if (parsed.values['auth-source']) runnerArgs.push('--auth-source', inputPath(parsed.values['auth-source']));
    const pointer = path.join(reportDirectory, `${plan.key}-run-pointer.json`);
    let result;
    try { result = await runCombination({ command: process.execPath, args: runnerArgs, cwd: runnerRepository,
      env: { ...process.env, DAYNIGHT_E2E_RUN_POINTER: pointer }, timeoutMs: 1_800_000, cleanupTimeoutMs: 180_000 }); }
    catch (error) {
      report.combinations[plan.key] = { phase: 'spawn', category: error instanceof Error ? error.name : 'unknown', pointer, cleanupEvidence: 'unconfirmed' };
      await save();
      return { kind: 'runner-error' };
    }
    let manifest: CombinationManifest | null = null, manifestPath: string | null = null;
    try {
      const location = JSON.parse(await readFile(pointer, 'utf8')) as { runDirectory: string };
      if (path.dirname(location.runDirectory) !== path.join(runnerRepository, '.tmp', 'product-e2e') || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(path.basename(location.runDirectory))) throw new Error('Combination pointer identifies an invalid run.');
      manifestPath = path.join(location.runDirectory, 'results', 'manifest.json');
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch { /* Missing evidence is reported separately from the child exit. */ }
    report.combinations[plan.key] = { ...result, pointer, manifestPath, manifest, cleanupEvidence: combinationCleanupConfirmed(result, manifest) ? 'confirmed' : 'unconfirmed' };
    await save();
    const passed = plan.workerVariant === undefined
      ? mixedCombinationPassed(result, manifest, candidateSha, baselineSha, plan.server)
      : candidateInput !== undefined && workerCombinationPassed(result, manifest, candidateSha, baselineSha, plan.workerVariant, candidateInput.hash);
    if (!passed) {
      console.error(`Compatibility combination ${plan.key} failed or cleanup is unconfirmed; pointer ${pointer}`);
    }
    return { kind: 'finished', result, manifest, passed };
  });
  let { failed, interrupted, unconfirmed } = sequence;
  if (sequence.stoppedAfter !== undefined) {
    recordStoppedSequence(report, plans, sequence);
    await save();
  }
  if (!interrupted && !unconfirmed) {
    const recoveryDirectory = path.join(reportDirectory, 'recovery');
    await mkdir(recoveryDirectory, { mode: 0o700 });
    const candidateInput = await verifiedCandidate();
    if (!candidateInput) {
      report.recovery = { status: 'not-run', reason: 'candidate-artifact-unverified', path: recoveryDirectory };
      failed = true;
    } else {
    let result;
    try { result = await runCombination({ command: process.execPath, args: [path.join(import.meta.dirname, 'subtask-compat-recovery.ts'), '--repository', runnerRepository, '--candidate', candidateSha, '--baseline', baselineSha, '--directory', recoveryDirectory, '--candidate-artifact', candidateArtifact, '--candidate-artifact-sha256', candidateInput.hash, '--candidate-manifest', candidateInput.manifestPath, '--old-cli', inputPath(parsed.values['old-cli']!), ...repairArgs], cwd: runnerRepository, env: process.env, timeoutMs: 1_800_000, cleanupTimeoutMs: 180_000 }); }
    catch (error) {
      report.recovery = { phase: 'spawn', category: error instanceof Error ? error.name : 'unknown', path: recoveryDirectory };
      failed = true;
    }
    let recovery: RecoveryReceipt | null = null;
    try { recovery = JSON.parse(await readFile(path.join(recoveryDirectory, 'recovery.json'), 'utf8')); } catch { /* Missing receipt is an incomplete result. */ }
    const cleanupConfirmed = recoveryCleanupConfirmed(result, recovery);
    if (result !== undefined) report.recovery = { ...result, receipt: recovery, path: recoveryDirectory, cleanupEvidence: cleanupConfirmed ? 'confirmed' : 'unconfirmed' };
    else report.recovery.cleanupEvidence = 'unconfirmed';
    if (!cleanupConfirmed) unconfirmed = true;
    if (result?.interrupted) interrupted = true;
    if (result === undefined || !recoveryPassed(result, recovery, candidateSha, baselineSha, candidateInput.hash, repair, { candidate: candidateInput.sourceFingerprint, baseline: candidateInput.baselineFingerprint, repair: repairFingerprint })) failed = true;
    }
  }
  if (!failed && !interrupted && !unconfirmed) {
    try { await rm(path.join(reportDirectory, 'private'), { recursive: true, force: true }); }
    catch { failed = true; report.recovery.handoffCleanup = 'failed'; }
  }
  report.status = unconfirmed ? 'unconfirmed' : interrupted ? 'interrupted' : failed ? 'failed' : 'passed';
  await save();
  if (failed || interrupted || unconfirmed) throw new Error(`Compatibility result is ${report.status}; see the report and run pointers.`);
  console.log('Both client combinations, both Goal Worker scenarios and isolated migration recovery passed with verified cleanup.');
}

try { await main(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
