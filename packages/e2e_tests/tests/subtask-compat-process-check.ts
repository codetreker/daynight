import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { sourceFingerprint } from '../src/build.ts';
import { runCommand } from '../src/command.ts';
import { candidateHandoffHash, combinationPassed, compatibilityPlans, executedScenario, goalWorkerName, mixedCombinationPassed, mixedVersionName, recordStoppedSequence, recoveryCleanupConfirmed, recoveryPassed, repairArguments, runCombination, runCompatibilityPlans, workerCombinationPassed } from '../src/subtask-compat-process.ts';
import { migrationManifestHash } from '../src/subtask-compat-recovery-migrations.ts';
import { revisionFingerprint } from '../src/subtask-compat-source.ts';

test('a passing child cannot substitute a different source revision or incomplete cleanup', () => {
  const result = { exitCode: 0, signal: null, interrupted: false, cleanupUnconfirmed: false };
  const manifest = { status: 'passed', artifacts: { sourceRevision: 'candidate' }, baselineArtifacts: { sourceRevision: 'baseline' }, cleanup: { completed: true } };
  assert.equal(combinationPassed(result, manifest, 'candidate', 'baseline'), true);
  assert.equal(combinationPassed(result, manifest, 'different', 'baseline'), false);
  assert.equal(combinationPassed(result, manifest, 'candidate', 'different'), false);
  assert.equal(combinationPassed(result, { ...manifest, cleanup: { completed: false } }, 'candidate', 'baseline'), false);
});

test('unconfirmed combination cleanup prevents every later combination from starting', async () => {
  const plans = compatibilityPlans();
  const failedResult = { exitCode: 1, signal: null, interrupted: false, cleanupUnconfirmed: false };
  for (const manifest of [null, {}, { cleanup: {} }, { cleanup: { completed: false } }]) {
    const started: string[] = [];
    const report: { status: string; combinations: Record<string, unknown>; recovery: Record<string, unknown> } = { status: 'running', combinations: {}, recovery: { status: 'not-run' } };
    const outcome = await runCompatibilityPlans(plans, async plan => {
      started.push(plan.key);
      report.combinations[plan.key] = { ...failedResult, manifest };
      return { kind: 'finished', result: failedResult, manifest, passed: false };
    });
    assert.deepEqual(started, ['candidate']);
    assert.deepEqual(outcome, { failed: true, interrupted: false, unconfirmed: true, stoppedAfter: 'candidate' });
    recordStoppedSequence(report, plans, outcome);
    assert.equal(report.status, 'unconfirmed');
    assert.deepEqual(report.combinations.candidate, { ...failedResult, manifest });
    for (const plan of plans.slice(1)) assert.deepEqual(report.combinations[plan.key], { status: 'not-run', reason: 'prior-cleanup-unconfirmed' });
    assert.deepEqual(report.recovery, { status: 'not-run', reason: 'prior-cleanup-unconfirmed' });
  }
  const started: string[] = [];
  const outcome = await runCompatibilityPlans(plans, async plan => {
    started.push(plan.key);
    return plan.key === 'baseline' ? { kind: 'runner-error' } : { kind: 'finished', result: { ...failedResult, exitCode: 0 }, manifest: { cleanup: { completed: true } }, passed: true };
  });
  assert.deepEqual(started, ['candidate', 'baseline']);
  assert.deepEqual(outcome, { failed: true, interrupted: false, unconfirmed: true, stoppedAfter: 'baseline' });
});

test('confirmed cleanup permits subsequent combinations after a test failure, while interruption stops them', async () => {
  const plans = compatibilityPlans(), started: string[] = [];
  const result = { exitCode: 1, signal: null, interrupted: false, cleanupUnconfirmed: false };
  const outcome = await runCompatibilityPlans(plans, async plan => {
    started.push(plan.key);
    return { kind: 'finished', result, manifest: { cleanup: { completed: true } }, passed: false };
  });
  assert.deepEqual(started, plans.map(plan => plan.key));
  assert.deepEqual(outcome, { failed: true, interrupted: false, unconfirmed: false });
  const interrupted = await runCompatibilityPlans(plans, async () => ({ kind: 'finished', result: { ...result, interrupted: true }, manifest: { cleanup: { completed: true } }, passed: false }));
  assert.deepEqual(interrupted, { failed: true, interrupted: true, unconfirmed: false, stoppedAfter: 'candidate' });
  const deadline = await runCompatibilityPlans(plans, async () => ({ kind: 'finished', result: { ...result, cleanupUnconfirmed: true }, manifest: { cleanup: { completed: true } }, passed: true }));
  assert.deepEqual(deadline, { failed: true, interrupted: false, unconfirmed: true, stoppedAfter: 'candidate' });
});

test('recovery requires its own confirmed cleanup receipt even when the child exits', () => {
  const result = { exitCode: 1, signal: null, interrupted: false, cleanupUnconfirmed: false };
  const receipt = { cleanup: { verified: true, quiescent: true, originQuiescent: true, usersStopped: true, pendingDocker: 0, pendingProcesses: 0 } };
  assert.equal(recoveryCleanupConfirmed(result, receipt), true);
  assert.equal(recoveryCleanupConfirmed(result, null), false);
  assert.equal(recoveryCleanupConfirmed(result, { cleanup: { ...receipt.cleanup, verified: false } }), false);
  assert.equal(recoveryCleanupConfirmed(result, { cleanup: { ...receipt.cleanup, pendingProcesses: 1 } }), false);
  assert.equal(recoveryCleanupConfirmed({ ...result, cleanupUnconfirmed: true }, receipt), false);
  assert.equal(recoveryCleanupConfirmed(undefined, receipt), false);
});

test('only the successful candidate combination can hand its exact built Server to recovery', () => {
  const result = { exitCode: 0, signal: null, interrupted: false, cleanupUnconfirmed: false }, hash = 'a'.repeat(64), filename = '/fixture/candidate-server';
  const manifest = { status: 'passed', combination: { server: 'candidate', baseline: 'baseline' }, artifacts: { sourceRevision: 'candidate', hashes: { server: hash } }, baselineArtifacts: { sourceRevision: 'baseline' }, selectedArtifacts: { server: hash }, candidateHandoff: { path: filename, sha256: hash, sourceRevision: 'candidate' }, harnessSHA256: hash, scenarios: [{ name: mixedVersionName('candidate'), status: 'passed' }], cleanup: { completed: true } };
  assert.equal(candidateHandoffHash(result, manifest, 'candidate', 'baseline', filename), hash);
  assert.equal(candidateHandoffHash(result, { ...manifest, combination: { ...manifest.combination, server: 'baseline' } }, 'candidate', 'baseline', filename), undefined);
  assert.equal(candidateHandoffHash(result, { ...manifest, candidateHandoff: { ...manifest.candidateHandoff, sha256: 'b'.repeat(64) } }, 'candidate', 'baseline', filename), undefined);
  assert.equal(candidateHandoffHash(result, manifest, 'candidate', 'baseline', '/other'), undefined);
  assert.equal(candidateHandoffHash({ ...result, exitCode: 1 }, manifest, 'candidate', 'baseline', filename), undefined);
  assert.equal(candidateHandoffHash(result, { ...manifest, scenarios: [] }, 'candidate', 'baseline', filename), undefined);
});

test('both mixed Server combinations require their own executed, non-skipped named case', () => {
  const result = { exitCode: 0, signal: null, interrupted: false, cleanupUnconfirmed: false }, hash = 'a'.repeat(64);
  const report = (title: string) => ({ stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 }, suites: [{ specs: [{ title, ok: true, tests: [{ status: 'expected', expectedStatus: 'passed', results: [{ status: 'passed' }] }] }] }] });
  for (const server of ['candidate', 'baseline'] as const) {
    const name = mixedVersionName(server), observed = report(name);
    assert.equal(executedScenario(observed, name), true);
    assert.equal(executedScenario({ ...observed, suites: [{ specs: [] }] }, name), false);
    assert.equal(executedScenario({ ...observed, stats: { ...observed.stats, skipped: 1 } }, name), false);
    assert.equal(executedScenario(report(mixedVersionName(server === 'candidate' ? 'baseline' : 'candidate')), name), false);
    const manifest = { status: 'passed', combination: { server, baseline: 'baseline' }, artifacts: { sourceRevision: 'candidate' }, baselineArtifacts: { sourceRevision: 'baseline' }, harnessSHA256: hash, scenarios: [{ name, status: 'passed' }], cleanup: { completed: true } };
    assert.equal(mixedCombinationPassed(result, manifest, 'candidate', 'baseline', server), true);
    assert.equal(mixedCombinationPassed(result, { ...manifest, scenarios: [] }, 'candidate', 'baseline', server), false);
    assert.equal(mixedCombinationPassed(result, { ...manifest, scenarios: [{ name, status: 'skipped' }] }, 'candidate', 'baseline', server), false);
    assert.equal(mixedCombinationPassed(result, { ...manifest, scenarios: [{ name: 'other', status: 'passed' }] }, 'candidate', 'baseline', server), false);
  }
});

test('both Worker variants require their own actually executed named case and candidate Server', () => {
  const plans = compatibilityPlans();
  assert.equal(new Set(plans.map(plan => plan.key)).size, 4);
  assert.deepEqual(plans.filter(plan => plan.workerVariant).map(plan => [plan.server, plan.workerVariant]), [['candidate', 'candidate'], ['candidate', 'npm-0.72.0']]);
  const result = { exitCode: 0, signal: null, interrupted: false, cleanupUnconfirmed: false }, hash = 'a'.repeat(64);
  const report = (title: string) => ({ stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 }, suites: [{ specs: [{ title, ok: true, tests: [{ status: 'expected', expectedStatus: 'passed', results: [{ status: 'passed' }] }] }] }] });
  for (const variant of ['candidate', 'npm-0.72.0'] as const) {
    const name = goalWorkerName(variant), observed = report(name);
    assert.equal(executedScenario(observed, name), true);
    assert.equal(executedScenario(observed, goalWorkerName(variant === 'candidate' ? 'npm-0.72.0' : 'candidate')), false);
    assert.equal(executedScenario({ ...observed, stats: { ...observed.stats, skipped: 1 } }, name), false);
    assert.equal(executedScenario({ ...observed, suites: [{ specs: [] }] }, name), false);
    const manifest = { status: 'passed', combination: { server: 'candidate', baseline: 'baseline', workerVariant: variant }, artifacts: { sourceRevision: 'candidate' }, baselineArtifacts: { sourceRevision: 'baseline' }, selectedArtifacts: { server: hash }, harnessSHA256: hash, scenarios: [{ name, status: 'passed' }], cleanup: { completed: true } };
    assert.equal(workerCombinationPassed(result, manifest, 'candidate', 'baseline', variant, hash), true);
    assert.equal(workerCombinationPassed(result, manifest, 'candidate', 'baseline', variant, 'b'.repeat(64)), false);
    assert.equal(workerCombinationPassed(result, { ...manifest, scenarios: [] }, 'candidate', 'baseline', variant, hash), false);
    assert.equal(workerCombinationPassed(result, { ...manifest, combination: { ...manifest.combination, workerVariant: 'other' } }, 'candidate', 'baseline', variant, hash), false);
  }
});

test('a recovery probe is not accepted without matching production artifact and full topology evidence', () => {
  const result = { exitCode: 0, signal: null, interrupted: false, cleanupUnconfirmed: false };
  const hash = 'a'.repeat(64), id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
  const repair = { revision: 'd'.repeat(40), artifact: '/repair', sha256: 'b'.repeat(64) };
  const entry = (version: number, checksum = hash) => ({ version, checksum });
  const baseline = [entry(99), entry(122)], candidate = [...baseline, entry(123), entry(124), entry(125), entry(126)];
  const probes = { baseline: { registry: 'legacy', sha256: hash }, candidate: { registry: 'baseline', sha256: hash }, repair: { registry: 'legacy', sha256: hash } };
  const fingerprints = { candidate: hash, baseline: 'b'.repeat(64), repair: 'c'.repeat(64), templateSHA256: hash, probes };
  const rows = (entries: typeof candidate) => entries.map(item => ({ ...item, applied_at: '2026-11-24T12:00:00Z' }));
  const manifests = { baselineRevision: 'baseline', candidateRevision: 'candidate', repairRevision: repair.revision, sourceFingerprints: fingerprints, probeSHA256: hash, probes, baseline, candidate, repair: candidate, baselineSHA256: migrationManifestHash(baseline), candidateSHA256: migrationManifestHash(candidate), repairSHA256: migrationManifestHash(candidate) };
  const receipt = { schemaVersion: 4, status: 'passed', candidate: 'candidate', baseline: 'baseline', repair: repair.revision, cleanup: { verified: true, quiescent: true, originQuiescent: true, usersStopped: true, pendingDocker: 0, pendingProcesses: 0 }, artifacts: { candidate: hash, candidateOrigin: 'candidate-combination', candidateWeb: 'production', baselineWeb: 'production', repairWeb: 'repair production', repair: repair.sha256, repairRevision: repair.revision, repairSuppliedSHA256: repair.sha256, repairReproducedSHA256: repair.sha256, controlledWebhook: 'test transport', baselineCli: { version: '0.72.0', gitHead: 'f5d73f3275c8e2774a588967a0fbdcd2a261c379', integrity: 'sha512-T85y9vOcRHjHvjFImEoDpOs25JxQkfSOLkSbmwUgVZi8S/KsQnVx3EJ5+r6Q/vwoGEP64HIPKdNHdUOVxpDe9w==' } }, acceptance: { authentication: 'normal', execution: 'dedicated-container' }, fixtureVerification: { verified: true, mode: 'normal-login-baseline-container' }, fixture: { project: id('1'), goal: id('2'), child: id('3'), hiddenGoal: id('4'), hiddenChild: id('5') }, recovery: { baselineVersion: 122, candidateVersion: 126, migrationManifests: manifests, candidateLedgerState: 'candidate', candidateLedgerSettled: true, precommitLedgerUnchanged: true, candidateLedger: JSON.stringify(rows(candidate)), snapshotSHA256: hash, storageSHA256: hash, historicalProjectionPreserved: true, receiverBefore: 0, receiverAfter: 1, receiverHashes: [hash], restoredLedger: true, attachmentRestored: true, postUpgradeWriteRemoved: true, epochRotated: true, endpointReconciled: true } };
  assert.equal(recoveryPassed(result, receipt, 'candidate', 'baseline', hash, repair, fingerprints), true);
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, migrationManifests: { ...manifests, probes: { ...probes, candidate: { ...probes.candidate, sha256: 'd'.repeat(64) } } } } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  const candidate124 = candidate.slice(0, 4), manifests124 = { ...manifests, candidate: candidate124, repair: candidate124, candidateSHA256: migrationManifestHash(candidate124), repairSHA256: migrationManifestHash(candidate124) };
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, candidateVersion: 124, migrationManifests: manifests124, candidateLedger: JSON.stringify(rows(candidate124)) } }, 'candidate', 'baseline', hash, repair, fingerprints), true);
  assert.equal(recoveryPassed(result, { ...receipt, fixtureVerification: { verified: false } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, receipt, 'candidate', 'baseline', 'b'.repeat(64), repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, schemaVersion: 2 }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, schemaVersion: 3 }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, cleanup: { ...receipt.cleanup, pendingDocker: 1 } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, cleanup: { ...receipt.cleanup, pendingProcesses: 1 } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, receiverAfter: 0 } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, artifacts: { ...receipt.artifacts, candidateOrigin: 'independent-clean-build' } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, receipt, 'other-candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, receipt, 'candidate', 'other-baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, fixture: { ...receipt.fixture, child: receipt.fixture.goal } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, fixtureVerification: { verified: true, mode: 'legacy' } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, artifacts: { ...receipt.artifacts, baselineCli: { ...receipt.artifacts.baselineCli, version: '0.71.0' } } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, acceptance: { ...receipt.acceptance, execution: 'host' } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, repair: 'e'.repeat(40) }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, artifacts: { ...receipt.artifacts, repairReproducedSHA256: 'c'.repeat(64) } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, artifacts: { ...receipt.artifacts, repairSuppliedSHA256: 'c'.repeat(64) } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, migrationManifests: undefined } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, migrationManifests: { ...manifests, candidateRevision: 'other' } } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, migrationManifests: { ...manifests, repairRevision: 'e'.repeat(40) } } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, candidateLedgerState: 'partial' } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, candidateLedgerSettled: false } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, candidateLedgerSettled: undefined } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, receipt, 'candidate', 'baseline', hash, repair, { ...fingerprints, candidate: 'd'.repeat(64) }), false);
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, migrationManifests: { ...manifests, sourceFingerprints: { ...manifests.sourceFingerprints, candidate: 'd'.repeat(64) } } } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, migrationManifests: { ...manifests, sourceFingerprints: { ...manifests.sourceFingerprints, baseline: 'd'.repeat(64) } } } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, migrationManifests: { ...manifests, sourceFingerprints: { ...manifests.sourceFingerprints, repair: 'd'.repeat(64) } } } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, migrationManifests: { ...manifests, sourceFingerprints: undefined } } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, candidateLedger: JSON.stringify(candidate) } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, candidateLedger: JSON.stringify(rows(candidate).map((row, i) => i === 2 ? { ...row, applied_at: null } : row)) } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, candidateLedger: JSON.stringify(rows(candidate.slice(0, -1))) } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, candidateLedger: JSON.stringify(rows(candidate.filter(item => item.version !== 124))) } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, candidateLedger: JSON.stringify(rows([...candidate, entry(127)])) } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, candidateLedger: JSON.stringify(rows([...candidate.slice(0, -1), entry(126, 'c'.repeat(64))])) } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, candidateVersion: 124 } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, migrationManifests: { ...manifests, candidateSHA256: 'c'.repeat(64) } } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  const differentRepair = [...candidate.slice(0, -1), entry(126, 'c'.repeat(64))];
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, migrationManifests: { ...manifests, repair: differentRepair, repairSHA256: migrationManifestHash(differentRepair) } } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  const baselineMismatch = [entry(1, 'c'.repeat(64)), entry(122)];
  assert.equal(recoveryPassed(result, { ...receipt, recovery: { ...receipt.recovery, migrationManifests: { ...manifests, baseline: baselineMismatch, baselineSHA256: migrationManifestHash(baselineMismatch) } } }, 'candidate', 'baseline', hash, repair, fingerprints), false);
  assert.deepEqual(repairArguments(repair), ['--repair-revision', repair.revision, '--repair-artifact', repair.artifact, '--repair-artifact-sha256', repair.sha256]);
  assert.throws(() => repairArguments({ ...repair, revision: 'e520' }), /required/);
  assert.throws(() => repairArguments({ ...repair, sha256: '' }), /required/);
});

test('repair source fingerprint comes from the exact clean commit and its private checkout is removed', async () => {
  const root = path.resolve(import.meta.dirname, '../../..');
  const temporary = await mkdtemp(path.join(root, '.tmp', 'compat-source-test-'));
  const repository = path.join(temporary, 'repository'), proofs = path.join(temporary, 'proofs');
  const git = async (args: string[]) => (await runCommand('git', args, { cwd: repository, timeoutMs: 30_000, onOutput: () => {} })).stdout.trim();
  try {
    await mkdir(path.join(repository, 'packages/daynight-server'), { recursive: true }); await mkdir(proofs);
    await git(['init', '--quiet']);
    const file = path.join(repository, 'packages/daynight-server', 'source.txt');
    await writeFile(file, 'original\n'); await git(['add', '.']);
    await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--quiet', '-m', 'original']);
    const revision = await git(['rev-parse', 'HEAD']), expected = await sourceFingerprint(repository);
    await writeFile(file, 'different working tree\n');
    assert.notEqual(await sourceFingerprint(repository), expected);
    assert.equal(await revisionFingerprint(repository, revision, proofs), expected);
    assert.deepEqual(await readdir(proofs), []);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('a failed spawn reports the error without an unhandled child event', async () => {
  await assert.rejects(runCombination({ command: '/no-such-subtask-compat-command', args: [], cwd: process.cwd(), env: process.env, timeoutMs: 1_000, cleanupTimeoutMs: 1_000 }), /did not start/);
});

test('cancellation waits for the inner runner to finish cleanup', async () => {
  const start = Date.now();
  const result = await runCombination({ command: process.execPath, cwd: process.cwd(), env: process.env, timeoutMs: 250, cleanupTimeoutMs: 3_000,
    args: ['-e', "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),800));setInterval(()=>{},1000)"] });
  assert.equal(result.interrupted, true);
  assert.equal(result.cleanupUnconfirmed, false);
  assert.equal(result.exitCode, 0);
  assert.ok(Date.now() - start >= 900);
});

test('cleanup deadline reports an unconfirmed live runner without killing it', async () => {
  const result = await runCombination({ command: process.execPath, cwd: process.cwd(), env: process.env, timeoutMs: 250, cleanupTimeoutMs: 150,
    args: ['-e', "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),600));setInterval(()=>{},1000)"] });
  assert.equal(result.interrupted, true);
  assert.equal(result.cleanupUnconfirmed, true);
  await new Promise(resolve => setTimeout(resolve, 750));
});
