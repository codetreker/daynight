import { expectedTargets, readAcceptanceScope, type AcceptanceScope, type AcceptanceTarget } from './inventory.mts';
import type { ProcessIdentity } from './identity.mts';
import type { Scenario } from './report.mts';
import type { BrowserInventory } from './browser.mts';
import type { StorageReceipt } from './storage.mts';
import type { InstalledCliReceipt } from './installed-cli.mts';
import type { AuthCombinedReceipt, RestartReceipt } from './auth-combined.mts';

export type Source = { gitSha: string; gitTreeSha: string; githubSha: string | null; dirty: boolean };
export type TargetIdentity = {
  target: 'native' | 'container'; baseUrl: string; postgresContainer: string;
  projectLabel: { key: string; value: string }; database: 'daynight';
};
export type BrowserPhase = TargetIdentity & {
  caseSensitiveStorage: boolean;
  phase: 'functional' | 'capacity'; result: 'running' | 'passed' | 'failed'; startedAt: string; finishedAt?: string;
  browserCleanup: 'not-started' | 'pending' | 'passed' | 'failed'; scenarios?: Scenario[]; browser?: unknown; error?: string;
  playwrightProcess?: ProcessIdentity; playwrightGroup?: number; browserInventory?: BrowserInventory;
};
export type Target = TargetIdentity & { result: 'running' | 'passed' | 'failed'; phases: BrowserPhase[]; scenarios?: Scenario[] };
export type Stage = {
  name: string; result: 'running' | 'passed' | 'failed'; startedAt: string; finishedAt?: string;
  commands: ProcessIdentity[]; commandGroups: number[]; error?: string;
};
export type NativeEvidence = {
  owner: string; postgresContainer: string; postgresVolume: string; binary: string; storageRoot: string; binarySha256?: string;
  processPid?: number; postgresImage: string; postgresImageId?: string; postgresVersion?: string; cleanup: 'pending' | 'passed' | 'failed';
  processIdentity?: ProcessIdentity; storage?: StorageReceipt; authFixtures?: AuthFixtureEvidence[]; processHistory?: ProcessIdentity[]; restarts?: RestartReceipt[];
};
export type AuthFixtureEvidence = { directory: string; binary: string; binarySha256: string; processPid?: number; processIdentity?: ProcessIdentity; cleanup: 'pending' | 'passed' | 'failed' };
export type InstalledEvidence = { root: string; receiptPath?: string; receipt?: InstalledCliReceipt; cleanup: 'pending' | 'passed' | 'failed' };
export type ReadyInstalledEvidence = InstalledEvidence & { receiptPath: string; receipt: InstalledCliReceipt };
type EvidenceBase = {
  schemaVersion: 4; runId: string; source: Source; startedAt: string; result: 'running' | 'passed' | 'failed';
  targets: Target[]; stages: Stage[]; container?: unknown; performance?: unknown;
  cleanup: 'pending' | 'passed' | 'failed'; finishedAt?: string; error?: string; cleanupErrors?: string[];
  installedCli?: InstalledEvidence;
  runner: ProcessIdentity; devCi?: { runId?: string; runner?: ProcessIdentity };
  authCombined?: AuthCombinedReceipt[];
};

export type Evidence = EvidenceBase & (
  { scope: 'container' } | { scope: 'native' | 'all'; native: NativeEvidence }
);
export const nativeEvidence = (evidence: Evidence): NativeEvidence => {
  if (evidence.scope === 'container') throw new Error('Container acceptance does not own native resources.');
  return evidence.native;
};

export const validateEvidenceScope = (value: unknown): AcceptanceScope => {
  const invalid: () => never = () => { throw new Error('Invalid acceptance scope or resource inventory.'); };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  const evidence = value as Record<string, unknown>;
  const scope = readAcceptanceScope(evidence.scope);
  if (scope === 'container') {
    if ('native' in evidence) invalid();
  } else {
    if (typeof evidence.native !== 'object' || evidence.native === null || Array.isArray(evidence.native)) invalid();
    const native = evidence.native as Record<string, unknown>;
    if (['owner', 'postgresContainer', 'postgresVolume', 'binary', 'storageRoot'].some((field) => typeof native[field] !== 'string' || native[field] === '')) invalid();
  }
  if (scope === 'native' && ('container' in evidence || 'devCi' in evidence)) invalid();
  if (!Array.isArray(evidence.targets) || !Array.isArray(evidence.stages)) invalid();
  const targets = new Set<string>();
  for (const raw of evidence.targets) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) invalid();
    const target = raw as Record<string, unknown>;
    if (typeof target.target !== 'string' || !expectedTargets(scope).includes(target.target as AcceptanceTarget) || targets.has(target.target) || !Array.isArray(target.phases)) invalid();
    targets.add(target.target);
    const phases = new Set<string>();
    for (const rawPhase of target.phases) {
      if (typeof rawPhase !== 'object' || rawPhase === null || Array.isArray(rawPhase)) invalid();
      const phase = rawPhase as Record<string, unknown>;
      if (phase.target !== target.target || (phase.phase !== 'functional' && !(target.target === 'native' && phase.phase === 'capacity')) || phases.has(String(phase.phase))) invalid();
      phases.add(String(phase.phase));
    }
  }
  const allowedStages = scope === 'all' ? ['native-preparation', 'native-functional', 'container-release', 'container', 'native-capacity']
    : scope === 'native' ? ['native-preparation', 'native-functional', 'native-capacity'] : ['cli-preparation', 'container'];
  const stages = new Set<string>();
  for (const raw of evidence.stages) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) invalid();
    const stage = raw as Record<string, unknown>;
    if (typeof stage.name !== 'string' || !allowedStages.includes(stage.name) || stages.has(stage.name)) invalid();
    stages.add(stage.name);
  }
  return scope;
};
