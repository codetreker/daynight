import { spawn } from 'node:child_process';
import { classifyMigrationLedger, migrationManifestHash, parseMigrationManifest, requireMigrationPlan } from './subtask-compat-recovery-migrations.ts';
import { fallbackBaseline, fallbackPatchSHA256 } from './subtask-compat-recovery-provenance.ts';

export type CombinationResult = { exitCode: number | null; signal: NodeJS.Signals | null; interrupted: boolean; cleanupUnconfirmed: boolean };
export type WorkerVariant = 'candidate' | 'npm-0.72.0';
export type CompatibilityPlan = { key: string; server: 'candidate' | 'baseline'; workerVariant?: WorkerVariant };
export const compatibilityPlans = (): CompatibilityPlan[] => [
  { key: 'candidate', server: 'candidate' }, { key: 'baseline', server: 'baseline' },
  { key: 'worker-candidate', server: 'candidate', workerVariant: 'candidate' },
  { key: 'worker-npm-0.72.0', server: 'candidate', workerVariant: 'npm-0.72.0' },
];
export type CombinationManifest = { status?: string; combination?: { server?: string; baseline?: string; workerVariant?: string }; artifacts?: { sourceRevision?: string; sourceFingerprint?: string; hashes?: { server?: string } }; baselineArtifacts?: { sourceRevision?: string; sourceFingerprint?: string }; selectedArtifacts?: { server?: string }; candidateHandoff?: { path?: string; sha256?: string; sourceRevision?: string }; scenarios?: { name?: string; status?: string }[]; harnessSHA256?: string; cleanup?: { completed?: boolean } };

export type CompatibilityStep =
  | { kind: 'not-run' }
  | { kind: 'runner-error' }
  | { kind: 'finished'; result: CombinationResult; manifest: CombinationManifest | null; passed: boolean };
export type CompatibilitySequence = { failed: boolean; interrupted: boolean; unconfirmed: boolean; stoppedAfter?: string };

export const combinationCleanupConfirmed = (result: CombinationResult, manifest: CombinationManifest | null): boolean =>
  !result.cleanupUnconfirmed && manifest?.cleanup?.completed === true;

// Every later run depends on the previous run having proved its own cleanup.
export const runCompatibilityPlans = async (plans: CompatibilityPlan[], run: (plan: CompatibilityPlan) => Promise<CompatibilityStep>): Promise<CompatibilitySequence> => {
  let failed = false;
  for (const plan of plans) {
    const step = await run(plan);
    if (step.kind === 'not-run') { failed = true; continue; }
    if (step.kind === 'runner-error') return { failed: true, interrupted: false, unconfirmed: true, stoppedAfter: plan.key };
    const unconfirmed = !combinationCleanupConfirmed(step.result, step.manifest);
    failed ||= !step.passed || unconfirmed;
    if (step.result.interrupted || unconfirmed) return { failed, interrupted: step.result.interrupted, unconfirmed, stoppedAfter: plan.key };
  }
  return { failed, interrupted: false, unconfirmed: false };
};

export const recordStoppedSequence = (report: { combinations: Record<string, unknown>; recovery: Record<string, unknown>; status: string }, plans: CompatibilityPlan[], sequence: CompatibilitySequence): void => {
  if (sequence.stoppedAfter === undefined) return;
  const reason = sequence.unconfirmed ? 'prior-cleanup-unconfirmed' : 'prior-run-interrupted';
  for (const plan of plans) if (!(plan.key in report.combinations)) report.combinations[plan.key] = { status: 'not-run', reason };
  report.recovery = { status: 'not-run', reason };
  report.status = sequence.unconfirmed ? 'unconfirmed' : 'interrupted';
};

export const combinationPassed = (result: CombinationResult, manifest: CombinationManifest | null, candidate: string, baseline: string): boolean =>
  result.exitCode === 0 && result.signal === null && !result.interrupted && !result.cleanupUnconfirmed &&
  manifest?.status === 'passed' && manifest.artifacts?.sourceRevision === candidate && manifest.baselineArtifacts?.sourceRevision === baseline && manifest.cleanup?.completed === true;

export const mixedVersionName = (server: 'candidate' | 'baseline'): string => `mixed versions: Web CLI and MCP against ${server} Server`;

export const mixedCombinationPassed = (result: CombinationResult, manifest: CombinationManifest | null, candidate: string, baseline: string, server: 'candidate' | 'baseline'): boolean =>
  combinationPassed(result, manifest, candidate, baseline) && manifest?.combination?.server === server && manifest.combination.baseline === baseline &&
  manifest.combination.workerVariant === undefined && /^[a-f0-9]{64}$/.test(manifest.harnessSHA256 ?? '') &&
  manifest.scenarios?.length === 1 && manifest.scenarios[0]?.name === mixedVersionName(server) && manifest.scenarios[0].status === 'passed';

export const candidateHandoffHash = (result: CombinationResult, manifest: CombinationManifest | null, candidate: string, baseline: string, expectedPath: string): string | undefined => {
  if (manifest === null || !mixedCombinationPassed(result, manifest, candidate, baseline, 'candidate')) return undefined;
  const hash = manifest.selectedArtifacts?.server;
  return hash && /^[a-f0-9]{64}$/.test(hash) && manifest.artifacts?.hashes?.server === hash && manifest.candidateHandoff?.sha256 === hash &&
    manifest.candidateHandoff.sourceRevision === candidate && manifest.candidateHandoff.path === expectedPath ? hash : undefined;
};

export const goalWorkerName = (variant: WorkerVariant): string => `Goal Worker five-edge claim and terminal ancestor: ${variant}`;

export const executedScenario = (report: unknown, title: string): boolean => {
  if (typeof report !== 'object' || report === null || Array.isArray(report)) return false;
  type Spec = { title?: string; ok?: boolean; tests?: { status?: string; expectedStatus?: string; results?: { status?: string }[] }[] };
  type Suite = { suites?: Suite[]; specs?: Spec[] };
  const root = report as { suites?: Suite[]; stats?: { expected?: number; skipped?: number; unexpected?: number; flaky?: number } };
  if (!Array.isArray(root.suites) || root.stats?.expected !== 1 || root.stats.skipped !== 0 || root.stats.unexpected !== 0 || root.stats.flaky !== 0) return false;
  const specs: Spec[] = []; let invalid = false;
  const visit = (suite: Suite): void => {
    if (typeof suite !== 'object' || suite === null || Array.isArray(suite)) { invalid = true; return; }
    if (Array.isArray(suite.specs)) specs.push(...suite.specs);
    if (Array.isArray(suite.suites)) suite.suites.forEach(visit);
  };
  root.suites.forEach(visit);
  if (invalid || specs.length !== 1 || specs[0]?.title !== title || specs[0].ok !== true || specs[0].tests?.length !== 1) return false;
  const test = specs[0].tests[0];
  return test?.status === 'expected' && test.expectedStatus === 'passed' && test.results?.length === 1 && test.results[0]?.status === 'passed';
};

export const workerCombinationPassed = (result: CombinationResult, manifest: CombinationManifest | null, candidate: string, baseline: string, variant: WorkerVariant, serverHash: string): boolean =>
  combinationPassed(result, manifest, candidate, baseline) && manifest?.combination?.server === 'candidate' && manifest.combination.baseline === baseline &&
  manifest.combination.workerVariant === variant && /^[a-f0-9]{64}$/.test(serverHash) && manifest.selectedArtifacts?.server === serverHash &&
  /^[a-f0-9]{64}$/.test(manifest.harnessSHA256 ?? '') && manifest.scenarios?.length === 1 && manifest.scenarios[0]?.name === goalWorkerName(variant) && manifest.scenarios[0].status === 'passed';

export type RecoveryReceipt = {
  schemaVersion?: number; status?: string; candidate?: string; baseline?: string; repair?: string;
  cleanup?: { verified?: boolean; quiescent?: boolean; originQuiescent?: boolean; usersStopped?: boolean; pendingDocker?: number; pendingProcesses?: number };
  artifacts?: { candidate?: string; candidateOrigin?: string; candidateWeb?: string; baselineWeb?: string; repairWeb?: string; repair?: string; repairRevision?: string; repairSuppliedSHA256?: string; repairReproducedSHA256?: string; controlledWebhook?: string; fallback?: { baseline?: string; patchSHA256?: string; baselineLedgerSHA256?: string; fallbackLedgerSHA256?: string; webSHA256?: string; reproducedWebSHA256?: string; serverSHA256?: string; reproducedServerSHA256?: string }; baselineCli?: { version?: string; gitHead?: string; integrity?: string } };
  acceptance?: { authentication?: string; execution?: string };
  fixtureVerification?: { verified?: boolean; mode?: string };
  fixture?: { user?: string; project?: string; goal?: string; child?: string; hiddenGoal?: string; hiddenChild?: string };
  recovery?: { baselineVersion?: number; candidateVersion?: number; migrationManifests?: { baselineRevision?: string; candidateRevision?: string; repairRevision?: string; sourceFingerprints?: { baseline?: string; candidate?: string; repair?: string }; probeSHA256?: string; probes?: Record<string, { registry?: string; sha256?: string }>; baseline?: unknown; candidate?: unknown; repair?: unknown; baselineSHA256?: string; candidateSHA256?: string; repairSHA256?: string }; candidateLedgerState?: string; candidateLedgerSettled?: boolean; precommitLedgerUnchanged?: boolean; candidateLedger?: string; snapshotSHA256?: string; storageSHA256?: string; historicalProjectionPreserved?: boolean; receiverBefore?: number; receiverAfter?: number; receiverHashes?: unknown; restoredLedger?: boolean; attachmentRestored?: boolean; postUpgradeWriteRemoved?: boolean; epochRotated?: boolean; endpointReconciled?: boolean; browser?: { originalCacheDigest?: string; servedWebFiles?: number; baselineSchema?: number; restoredEpoch?: string; restored?: { epoch?: string; user?: string; project?: string; child?: string; hiddenChild?: string; originalCacheDigest?: string; sameContext?: boolean; candidateTabRetired?: boolean; attachment?: string; history?: string; deletedStatus?: number }; failures?: { denied?: boolean; offline?: boolean; storage?: boolean; storageInjected?: boolean; blocked?: boolean }; storageFailure?: { errorName?: string; namespace?: string }; restart?: { epoch?: string; user?: string; kind?: string; sameProfile?: boolean } } };
};
export type RepairIdentity = { revision: string; artifact: string; sha256: string };
export type RecoveryFingerprints = { candidate: string; baseline: string; repair: string; templateSHA256: string; probes: Record<'baseline' | 'candidate' | 'repair', { registry: string; sha256: string }> };
export const recoveryCleanupConfirmed = (result: CombinationResult | undefined, receipt: RecoveryReceipt | null): boolean =>
  result !== undefined && !result.cleanupUnconfirmed && receipt?.cleanup?.verified === true && receipt.cleanup.quiescent === true &&
  receipt.cleanup.originQuiescent === true && receipt.cleanup.usersStopped === true && receipt.cleanup.pendingDocker === 0 && receipt.cleanup.pendingProcesses === 0;
export const repairArguments = (repair: RepairIdentity): string[] => {
  if (!/^[a-f0-9]{40}$/.test(repair.revision) || !/^[a-f0-9]{64}$/.test(repair.sha256) || !repair.artifact) throw new Error('Repair revision, artifact and SHA-256 are required.');
  return ['--repair-revision', repair.revision, '--repair-artifact', repair.artifact, '--repair-artifact-sha256', repair.sha256];
};
const validRecoveryLedger = (recovery: RecoveryReceipt['recovery'], candidateSha: string, baselineSha: string, repairSha: string, fingerprints: RecoveryFingerprints): boolean => {
  try {
    const manifests = recovery?.migrationManifests;
    if (!manifests || manifests.baselineRevision !== baselineSha || manifests.candidateRevision !== candidateSha || manifests.repairRevision !== repairSha ||
      ![fingerprints.candidate, fingerprints.baseline, fingerprints.repair].every(value => /^[a-f0-9]{64}$/.test(value)) ||
      manifests.sourceFingerprints?.candidate !== fingerprints.candidate || manifests.sourceFingerprints.baseline !== fingerprints.baseline || manifests.sourceFingerprints.repair !== fingerprints.repair || !/^[a-f0-9]{64}$/.test(manifests.probeSHA256 ?? '') ||
      manifests.probeSHA256 !== fingerprints.templateSHA256 || !(['baseline', 'candidate', 'repair'] as const).every(name => manifests.probes?.[name]?.registry === fingerprints.probes[name].registry && manifests.probes?.[name]?.sha256 === fingerprints.probes[name].sha256 && /^[a-f0-9]{64}$/.test(fingerprints.probes[name].sha256)) ||
      recovery?.candidateLedgerState !== 'candidate' || recovery.candidateLedgerSettled !== true || typeof recovery.candidateLedger !== 'string') return false;
    const baseline = parseMigrationManifest(manifests.baseline), candidate = parseMigrationManifest(manifests.candidate), repair = parseMigrationManifest(manifests.repair);
    requireMigrationPlan(baseline, candidate, repair);
    if (recovery.baselineVersion !== baseline.at(-1)?.version || recovery.candidateVersion !== candidate.at(-1)?.version ||
      manifests.baselineSHA256 !== migrationManifestHash(baseline) || manifests.candidateSHA256 !== migrationManifestHash(candidate) ||
      manifests.repairSHA256 !== migrationManifestHash(repair)) return false;
    const rows: unknown = JSON.parse(recovery.candidateLedger);
    if (!Array.isArray(rows)) return false;
    const entries = rows.map(row => {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new Error('Invalid ledger row.');
      if (Object.keys(row).sort().join(',') !== 'applied_at,checksum,version' || typeof row.applied_at !== 'string' || row.applied_at.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(row.applied_at)) throw new Error('Invalid ledger row.');
      return { version: row.version, checksum: row.checksum };
    });
    return classifyMigrationLedger(parseMigrationManifest(entries), baseline, candidate) === 'candidate';
  } catch { return false; }
};
const validFixture = (fixture: RecoveryReceipt['fixture']): boolean => {
  const ids = [fixture?.user, fixture?.project, fixture?.goal, fixture?.child, fixture?.hiddenGoal, fixture?.hiddenChild];
  return ids.every(value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) && new Set(ids).size === ids.length;
};
const validFallback = (receipt: RecoveryReceipt): boolean => {
  const artifact = receipt.artifacts?.fallback, browser = receipt.recovery?.browser, fixture = receipt.fixture;
  const digest = (value: string | undefined): boolean => /^[a-f0-9]{64}$/.test(value ?? '');
  const epoch = browser?.restoredEpoch;
  if (!browser?.restored || !browser.restart) return false;
  return receipt.baseline === fallbackBaseline && artifact?.baseline === fallbackBaseline && artifact.patchSHA256 === fallbackPatchSHA256 &&
    digest(artifact.baselineLedgerSHA256) && artifact.baselineLedgerSHA256 === receipt.recovery?.migrationManifests?.baselineSHA256 && artifact.fallbackLedgerSHA256 === artifact.baselineLedgerSHA256 &&
    digest(artifact.webSHA256) && artifact.webSHA256 === artifact.reproducedWebSHA256 && digest(artifact.serverSHA256) && artifact.serverSHA256 === artifact.reproducedServerSHA256 &&
    Number.isSafeInteger(browser.servedWebFiles) && (browser.servedWebFiles ?? 0) > 1 && browser.baselineSchema === 13 && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(epoch ?? '') &&
    browser.restored?.epoch === epoch && browser.restored.user === fixture?.user && browser.restored.project === fixture?.project && browser.restored.child === fixture?.child && browser.restored.hiddenChild === fixture?.hiddenChild &&
    digest(browser.originalCacheDigest) && browser.restored.originalCacheDigest === browser.originalCacheDigest && browser.restored.sameContext === true && browser.restored.candidateTabRetired === true && browser.restored.attachment === 'paired122' && browser.restored.history === 'baseline-only' && browser.restored.deletedStatus === 410 &&
    browser.failures?.denied === true && browser.failures.offline === true && browser.failures.storage === true && browser.failures.storageInjected === true && browser.failures.blocked === true && browser.storageFailure?.errorName === 'VersionError' && browser.storageFailure.namespace === 'daynight-task-cache-recovery-12ebdd08' && browser.restart?.epoch === epoch && browser.restart.user === fixture?.user && browser.restart.kind === 'persistent-browser-process' && browser.restart.sameProfile === true;
};
export const recoveryPassed = (result: CombinationResult, receipt: RecoveryReceipt | null, candidate: string, baseline: string, candidateServer: string | undefined, repair: RepairIdentity, fingerprints: RecoveryFingerprints): boolean =>
  result.exitCode === 0 && result.signal === null && !result.interrupted && !result.cleanupUnconfirmed && receipt?.schemaVersion === 4 &&
  receipt.status === 'passed' && receipt.candidate === candidate && receipt.baseline === baseline && receipt.cleanup?.verified === true &&
  receipt.cleanup.quiescent === true && receipt.cleanup.originQuiescent === true && receipt.cleanup.usersStopped === true && receipt.cleanup.pendingDocker === 0 && receipt.cleanup.pendingProcesses === 0 &&
  candidateServer !== undefined && /^[a-f0-9]{64}$/.test(candidateServer) && receipt.artifacts?.candidate === candidateServer && receipt.artifacts.candidateOrigin === 'candidate-combination' &&
  /^[a-f0-9]{40}$/.test(repair.revision) && /^[a-f0-9]{64}$/.test(repair.sha256) && receipt.repair === repair.revision &&
  receipt.artifacts.repairRevision === repair.revision && receipt.artifacts.repair === repair.sha256 && receipt.artifacts.repairSuppliedSHA256 === repair.sha256 && receipt.artifacts.repairReproducedSHA256 === repair.sha256 && receipt.artifacts.repairWeb === 'repair production' &&
  receipt.artifacts.candidateWeb === 'production' && receipt.artifacts.baselineWeb === 'production' && receipt.artifacts.controlledWebhook === 'test transport' &&
  receipt.artifacts.baselineCli?.version === '0.72.0' && receipt.artifacts.baselineCli.gitHead === 'f5d73f3275c8e2774a588967a0fbdcd2a261c379' && receipt.artifacts.baselineCli.integrity === 'sha512-T85y9vOcRHjHvjFImEoDpOs25JxQkfSOLkSbmwUgVZi8S/KsQnVx3EJ5+r6Q/vwoGEP64HIPKdNHdUOVxpDe9w==' &&
  receipt.fixtureVerification?.verified === true && receipt.fixtureVerification.mode === 'normal-login-baseline-container' && receipt.acceptance?.authentication === 'normal' && receipt.acceptance.execution === 'dedicated-container' &&
  validFixture(receipt.fixture) && validFallback(receipt) &&
  validRecoveryLedger(receipt.recovery, candidate, baseline, repair.revision, fingerprints) && receipt.recovery?.precommitLedgerUnchanged === true &&
  /^[a-f0-9]{64}$/.test(receipt.recovery.snapshotSHA256 ?? '') && /^[a-f0-9]{64}$/.test(receipt.recovery.storageSHA256 ?? '') &&
  receipt.recovery.historicalProjectionPreserved === true && receipt.recovery.receiverBefore === 0 && receipt.recovery.receiverAfter === 1 && Array.isArray(receipt.recovery.receiverHashes) && receipt.recovery.receiverHashes.length === 1 && /^[a-f0-9]{64}$/.test(receipt.recovery.receiverHashes[0]) &&
  receipt.recovery.restoredLedger === true && receipt.recovery.attachmentRestored === true && receipt.recovery.postUpgradeWriteRemoved === true &&
  receipt.recovery.epochRotated === true && receipt.recovery.endpointReconciled === true;

// The inner runner owns its application, browser and Docker cleanup. A signal
// asks that runner to cancel; it must not be followed by the command helper's
// short process-group kill while that cleanup is still running.
export async function runCombination(input: {
  command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  timeoutMs: number; cleanupTimeoutMs: number;
}): Promise<CombinationResult> {
  const child = spawn(input.command, input.args, { cwd: input.cwd, env: input.env, detached: true, stdio: 'inherit' });
  if (child.pid === undefined) {
    const cause = await new Promise<Error>(resolve => child.once('error', resolve));
    throw new Error('Compatibility runner did not start.', { cause });
  }
  let interrupted = false;
  let cleanupTimer: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let resolveUnconfirmed: () => void = () => {};
  const unconfirmed = new Promise<'unconfirmed'>(resolve => { resolveUnconfirmed = () => resolve('unconfirmed'); });
  const cancel = (): void => {
    if (interrupted) return;
    interrupted = true;
    try { process.kill(child.pid!, 'SIGTERM'); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) { resolveUnconfirmed(); return; }
    }
    cleanupTimer = setTimeout(resolveUnconfirmed, input.cleanupTimeoutMs);
  };
  const onSignal = (): void => cancel();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  timeout = setTimeout(cancel, input.timeoutMs);
  try {
    const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    const result = await Promise.race([exited, unconfirmed]);
    if (result === 'unconfirmed') {
      child.unref();
      return { exitCode: null, signal: null, interrupted, cleanupUnconfirmed: true };
    }
    return { ...result, interrupted, cleanupUnconfirmed: false };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (cleanupTimer) clearTimeout(cleanupTimer);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
