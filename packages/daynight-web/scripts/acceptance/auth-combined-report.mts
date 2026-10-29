import type { ProcessIdentity } from './identity.mts';
import type { BrowserInventory } from './browser.mts';
import type { CombinedTarget } from './auth-combined-target.mts';

export type RestartReceipt = {
  target: 'native' | 'container'; origin: string; startedAt: string; readyAt: string;
  before: { pid: number; start: string }; after: { pid: number; start: string };
  binaryOrImage: string; containerId?: string;
};
type Check = { name: string; result: 'passed'; details: Record<string, unknown> };
export type AuthCombinedReceipt = {
  schemaVersion: 1; kind: 'auth-combined'; target: 'native' | 'container'; sourceGitSha: string;
  origin: string; result: 'running' | 'passed' | 'failed'; startedAt: string; finishedAt?: string;
  cleanup: 'pending' | 'passed' | 'failed'; browserCleanup: 'not-started' | 'pending' | 'passed' | 'failed';
  browserInventory?: BrowserInventory; browser?: { name: string; version: string; platform: string; executableOverride: boolean };
  installedCli: { version: string; sourceGitSha: string; entrySha256: string; tarballSha256: string };
  checks: Check[]; screenshots: string[]; commands: ProcessIdentity[]; commandGroups: number[];
  restart?: RestartReceipt; error?: string; cleanupErrors?: string[];
};
export type AuthCombinedResult = Pick<AuthCombinedReceipt, 'schemaVersion' | 'kind' | 'target' | 'sourceGitSha' | 'origin' | 'result'
  | 'startedAt' | 'finishedAt' | 'cleanup' | 'browserCleanup' | 'browser' | 'installedCli' | 'screenshots' | 'restart'>
  & { checks: { name: string; result: 'passed' }[] };

export const requiredCombinedChecks = ['partial-sharing', 'normal-member-writes', 'bilingual-token', 'same-data-cli-browser',
  'restart-original-state', 'logout-independent-pat', 'pat-revocation', 'socket-disconnect',
  'admitted-member-removal', 'expired-pat', 'secret-scan'] as const;

export class CombinedFailure extends Error {}
const check: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) throw new CombinedFailure(message); };

export const validateAuthCombinedResult = (value: unknown, target: Pick<CombinedTarget, 'target' | 'baseUrl' | 'sourceGitSha'>, platform: string, ci: boolean): AuthCombinedResult => {
  check(typeof value === 'object' && value !== null, 'Combined receipt is missing.');
  const receipt = value as AuthCombinedResult;
  check(receipt.schemaVersion === 1 && receipt.kind === 'auth-combined' && receipt.result === 'passed'
    && receipt.cleanup === 'passed' && receipt.browserCleanup === 'passed' && receipt.target === target.target
    && receipt.origin === target.baseUrl && receipt.sourceGitSha === target.sourceGitSha, 'Combined receipt identity or cleanup differs.');
  check(receipt.checks.length === requiredCombinedChecks.length && requiredCombinedChecks.every((name) => receipt.checks.filter((entry) => entry.name === name && entry.result === 'passed').length === 1), 'Combined receipt does not contain every required result exactly once.');
  check(receipt.restart?.origin === target.baseUrl && receipt.restart.before.pid !== receipt.restart.after.pid
    && receipt.restart.before.start !== receipt.restart.after.start, 'Combined restart did not replace the owned process.');
  check(receipt.browser?.name === 'chromium' && /^\d+\.\d+\.\d+\.\d+$/.test(receipt.browser.version)
    && receipt.browser.platform === platform && ['linux', 'darwin'].includes(receipt.browser.platform)
    && (!ci || receipt.browser.executableOverride === false), 'Combined browser identity is invalid.');
  check(receipt.installedCli.sourceGitSha === target.sourceGitSha && receipt.screenshots.length >= 2, 'Combined CLI source or screenshot evidence is missing.');
  return receipt;
};

export const validateAuthCombinedReceipt = (value: unknown, target: Pick<CombinedTarget, 'target' | 'baseUrl' | 'sourceGitSha'>): AuthCombinedReceipt => {
  validateAuthCombinedResult(value, target, process.platform, Boolean(process.env.CI));
  return value as AuthCombinedReceipt;
};
