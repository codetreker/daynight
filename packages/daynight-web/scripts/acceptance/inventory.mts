export const functionalScenarios = ['project-list', 'project-graph', 'detail-navigation', 'refresh-staleness',
  'failure-recovery', 'deep-links', 'keyboard-focus', 'narrow-layout', 'task-attachments', 'task-detail-page', 'project-view-tabs',
  'language-startup-preferences', 'language-state-preservation', 'language-errors-and-narrow',
  'task-description-markdown', 'task-status', 'task-status-conflicts', 'task-status-recovery', 'task-status-transitions', 'task-agent-permission', 'task-platform', 'task-assignment', 'task-assignment-layout',
  'auth-login-session', 'auth-project-isolation', 'auth-project-members', 'auth-personal-tokens',
  'auth-invitations', 'auth-resource-session', 'project-settings', 'project-access-projections', 'task-execution-time', 'task-pause', 'task-step-status', 'task-step-access-retirement', 'task-step-position', 'task-step-add', 'task-step-edit', 'task-step-delete', 'assistant-composition', 'session-footer-mouse', 'session-footer-touch'] as const;

export const authCombinedChecks = ['partial-sharing', 'normal-member-writes', 'bilingual-token', 'same-data-cli-browser',
  'restart-original-state', 'logout-independent-pat', 'pat-revocation', 'socket-disconnect', 'membership-revocation', 'expired-pat', 'secret-scan'] as const;

export const validMembershipRevocation = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>, details = entry.details;
  if (entry.name !== 'membership-revocation' || entry.result !== 'passed' || typeof details !== 'object' || details === null || Array.isArray(details)) return false;
  const proof = details as Record<string, unknown>, uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  return ['projectId', 'taskId', 'memberId'].every(key => typeof proof[key] === 'string' && uuid.test(proof[key]))
    && proof.removalStatus === 204 && proof.newResourceStatus === 404 && proof.privateProjectStatus === 200
    && ['memberAbsent', 'ownerBytesRetained', 'cliDenied', 'browserUnavailable'].every(key => proof[key] === true);
};

export const validSocketDisconnect = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>, details = entry.details;
  if (entry.name !== 'socket-disconnect' || entry.result !== 'passed' || typeof details !== 'object' || details === null || Array.isArray(details)) return false;
  const proof = details as Record<string, unknown>;
  return typeof proof.path === 'string' && /^admission\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/abort\.bin$/.test(proof.path)
    && typeof proof.requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(proof.requestId)
    && proof.prefixBytes === 65_536 && proof.socketClosed === true && proof.stagingRemoved === true
    && proof.resourceStatus === 404 && proof.listingAbsent === true && proof.taskUnchanged === true;
};
