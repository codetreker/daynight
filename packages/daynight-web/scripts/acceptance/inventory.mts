export const functionalScenarios = ['project-list', 'project-graph', 'detail-navigation', 'refresh-staleness',
  'failure-recovery', 'deep-links', 'keyboard-focus', 'narrow-layout', 'task-attachments', 'task-detail-page', 'project-view-tabs',
  'language-startup-preferences', 'language-state-preservation', 'language-errors-and-narrow',
  'task-description-markdown', 'task-status', 'task-status-conflicts', 'task-status-recovery', 'task-status-transitions', 'task-agent-permission', 'task-platform', 'task-assignment', 'task-assignment-layout',
  'auth-login-session', 'auth-project-isolation', 'auth-project-members', 'auth-personal-tokens',
  'auth-invitations', 'auth-resource-session', 'project-settings', 'task-execution-time', 'task-pause', 'task-step-status', 'task-step-access-retirement', 'task-step-position', 'task-step-add', 'task-step-edit', 'task-step-delete', 'assistant-composition', 'session-footer-mouse', 'session-footer-touch'] as const;

export const authCombinedChecks = ['partial-sharing', 'normal-member-writes', 'bilingual-token', 'same-data-cli-browser',
  'restart-original-state', 'logout-independent-pat', 'pat-revocation', 'socket-disconnect',
  'admitted-member-removal', 'expired-pat', 'secret-scan'] as const;

export const validAdmittedRemoval = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>, details = entry.details;
  if (entry.name !== 'admitted-member-removal' || entry.result !== 'passed' || typeof details !== 'object' || details === null || Array.isArray(details)) return false;
  const proof = details as Record<string, unknown>, lock = proof.grantLock, observed = proof.observedWhileBodyIncomplete;
  if (typeof lock !== 'object' || lock === null || Array.isArray(lock) || typeof observed !== 'object' || observed === null || Array.isArray(observed)) return false;
  const pids = lock as Record<string, unknown>, held = observed as Record<string, unknown>;
  return Number.isSafeInteger(pids.waiterPid) && Number(pids.waiterPid) > 0 && Number.isSafeInteger(pids.blockerPid)
    && Number(pids.blockerPid) > 0 && pids.waiterPid !== pids.blockerPid
    && proof.prefixBytes === 65_536 && typeof proof.prefixSha256 === 'string' && /^[0-9a-f]{64}$/.test(proof.prefixSha256)
    && held.temporaryFiles === 1 && held.temporaryBytes === proof.prefixBytes && held.temporarySha256 === proof.prefixSha256
    && held.finalExists === false && held.metadataRows === 0 && held.memberRows === 1
    && proof.status === 201 && proof.removalStatus === 204 && proof.newResourceStatus === 404 && proof.privateProjectStatus === 200;
};
