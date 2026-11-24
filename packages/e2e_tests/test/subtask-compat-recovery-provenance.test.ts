import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyCandidateCombination } from '../src/subtask-compat-recovery-provenance.ts';

const candidate = 'a'.repeat(40), baseline = 'b'.repeat(40), sha256 = 'c'.repeat(64), sourceFingerprint = 'd'.repeat(64);
const manifest = () => ({ status: 'passed', cleanup: { completed: true }, combination: { server: 'candidate', baseline },
  artifacts: { sourceRevision: candidate, sourceFingerprint, hashes: { server: sha256 } }, selectedArtifacts: { server: sha256 } });
const check = (value: unknown) => verifyCandidateCombination({ manifest: value, candidate, baseline, sha256, sourceFingerprint });

test('shared candidate requires matching successful combination provenance', () => {
  assert.doesNotThrow(() => check(manifest()));
  const changes = [
    (value: ReturnType<typeof manifest>) => { value.status = 'failed'; },
    (value: ReturnType<typeof manifest>) => { value.cleanup.completed = false; },
    (value: ReturnType<typeof manifest>) => { value.combination.server = 'baseline'; },
    (value: ReturnType<typeof manifest>) => { value.combination.baseline = 'e'.repeat(40); },
    (value: ReturnType<typeof manifest>) => { value.artifacts.sourceRevision = 'e'.repeat(40); },
    (value: ReturnType<typeof manifest>) => { value.artifacts.sourceFingerprint = 'e'.repeat(64); },
    (value: ReturnType<typeof manifest>) => { value.artifacts.hashes.server = 'e'.repeat(64); },
    (value: ReturnType<typeof manifest>) => { value.selectedArtifacts.server = 'e'.repeat(64); },
  ];
  for (const change of changes) { const value = manifest(); change(value); assert.throws(() => check(value), /provenance mismatch/); }
});

test('repair artifact requires clean source identity and reproduced identical bytes', async () => {
  const { verifyRepairArtifact } = await import('../src/subtask-compat-recovery-provenance.ts');
  const buildInfo = `server: go1.27.2\n\tpath\tgithub.com/codetreker/daynight/packages/daynight-server/cmd/daynight-server\n\tbuild\tvcs.revision=${candidate}\n\tbuild\tvcs.modified=false\n\tbuild\t-trimpath=true\n\tbuild\tCGO_ENABLED=0\n`;
  const valid = { revision: candidate, expectedSHA256: sha256, suppliedSHA256: sha256, copiedSHA256: sha256, reproducedSHA256: sha256, buildInfo };
  assert.doesNotThrow(() => verifyRepairArtifact(valid));
  for (const change of [
    { suppliedSHA256: 'e'.repeat(64) }, { copiedSHA256: 'e'.repeat(64) }, { reproducedSHA256: 'e'.repeat(64) },
    { revision: 'e'.repeat(40) }, { buildInfo: buildInfo.replace('vcs.modified=false', 'vcs.modified=true') },
    { buildInfo: buildInfo.replace('go1.27.2', 'go1.26.6') }, { buildInfo: buildInfo.replace('-trimpath=true', '-trimpath=false') }, { buildInfo: buildInfo + '\t=>\tlocal-module\n' },
  ]) assert.throws(() => verifyRepairArtifact({ ...valid, ...change }), /provenance or reproducible build mismatch/);
});

test('candidate build settings cannot select a different registry than the probe', async () => {
  const { verifyCandidateBuild } = await import('../src/subtask-compat-recovery-provenance.ts');
  const buildInfo = `server: go1.27.2\n\tpath\tgithub.com/codetreker/daynight/packages/daynight-server/cmd/daynight-server\n\tbuild\t-buildmode=exe\n\tbuild\t-compiler=gc\n\tbuild\t-trimpath=true\n\tbuild\tCGO_ENABLED=0\n\tbuild\tGOARCH=amd64\n\tbuild\tGOOS=linux\n\tbuild\tGOAMD64=v1\n\tbuild\tvcs=git\n\tbuild\tvcs.revision=${candidate}\n\tbuild\tvcs.time=2026-01-01T00:00:00Z\n\tbuild\tvcs.modified=true\n`;
  const check = (info: string) => verifyCandidateBuild({ revision: candidate, architecture: 'amd64', buildInfo: info });
  assert.doesNotThrow(() => check(buildInfo));
  for (const altered of [buildInfo + '\tbuild\t-tags=custom\n', buildInfo + '\tbuild\t-ldflags=custom\n', buildInfo + '\t=>\tlocal\n',
    buildInfo.replace('GOAMD64=v1', 'GOAMD64=v3'), buildInfo.replace('CGO_ENABLED=0', 'CGO_ENABLED=1'), buildInfo.replace('go1.27.2', 'go1.26.6')]) {
    assert.throws(() => check(altered), /build settings/);
  }
  assert.throws(() => check(buildInfo + '\tbuild\tGOARCH=amd64\n'), /ambiguous/);
});

test('authenticated recovery refuses missing candidate or repair inputs before building', async () => {
  const { runAuthenticatedRecovery } = await import('../src/subtask-compat-recovery-real.ts');
  const denied = async (): Promise<never> => { throw new Error('unexpected operation'); };
  const resources = { network: 'n', ingress: 'i', volume: 'v', postgres: 'p', redis: 'r', auth: 'a', old: 'o', candidate: 'c', repair: 'x', controlled: 'w', image: 'im' };
  const base: Parameters<typeof runAuthenticatedRecovery>[0] = { repository: '/unused', directory: '/unused', runtime: '/unused', candidate, baseline, runId: 'unused', resources,
    signal: new AbortController().signal, oldCli: '/unused/old.tgz', command: denied, observe: denied, clone: denied, mutation: denied, startRelated: denied,
    phase: denied, browserOwner: denied, evidence: denied };
  await assert.rejects(runAuthenticatedRecovery(base), /Candidate combination artifact is required/);
  const sharedCandidate = { binary: '/unused/candidate', sha256, manifest: '/unused/manifest' };
  await assert.rejects(runAuthenticatedRecovery({ ...base, sharedCandidate }), /Explicit repair artifact, revision and SHA-256 are required/);
  await assert.rejects(runAuthenticatedRecovery({ ...base, sharedCandidate, repair: { revision: candidate, artifact: '/unused/repair', sha256: 'invalid' } }), /Repair artifact identity is invalid/);
});

test('fallback requires the pinned patch, baseline ledger and two identical embedded builds', async () => {
  const { fallbackBaseline, fallbackPatchSHA256, verifyFallbackArtifact } = await import('../src/subtask-compat-recovery-provenance.ts');
  const buildInfo = `server: go1.27.2\n\tpath\tgithub.com/codetreker/daynight/packages/daynight-server/cmd/daynight-server\n\tbuild\tvcs.revision=${fallbackBaseline}\n\tbuild\tvcs.modified=true\n\tbuild\t-trimpath=true\n\tbuild\tCGO_ENABLED=0\n`;
  const valid = { baseline: fallbackBaseline, patchSHA256: fallbackPatchSHA256, baselineLedgerSHA256: sha256, fallbackLedgerSHA256: sha256,
    webSHA256: sha256, reproducedWebSHA256: sha256, serverSHA256: sha256, reproducedServerSHA256: sha256, buildInfo };
  assert.doesNotThrow(() => verifyFallbackArtifact(valid));
  for (const change of [{ baseline: candidate }, { patchSHA256: 'a'.repeat(64) }, { fallbackLedgerSHA256: 'a'.repeat(64) },
    { reproducedWebSHA256: 'a'.repeat(64) }, { reproducedServerSHA256: 'a'.repeat(64) },
    { buildInfo: buildInfo.replace('vcs.modified=true', 'vcs.modified=false') }, { buildInfo: buildInfo.replace('go1.27.2', 'go1.26.6') },
    { serverSHA256: 'bad', reproducedServerSHA256: 'bad' }, { buildInfo: buildInfo + '\t=>\tlocal-module\n' }]) {
    assert.throws(() => verifyFallbackArtifact({ ...valid, ...change }), /Fallback artifact provenance/);
  }
});
