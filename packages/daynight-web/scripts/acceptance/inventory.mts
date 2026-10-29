export const functionalScenarios = ['project-list', 'project-graph', 'detail-navigation', 'refresh-staleness',
  'failure-recovery', 'deep-links', 'keyboard-focus', 'narrow-layout', 'task-attachments', 'task-detail-page', 'project-view-tabs',
  'language-startup-preferences', 'language-state-preservation', 'language-errors-and-narrow',
  'task-description-markdown', 'task-status', 'task-status-conflicts', 'task-status-recovery', 'task-status-transitions', 'task-agent-permission', 'task-platform',
  'auth-login-session', 'auth-project-isolation', 'auth-project-members', 'auth-personal-tokens',
  'auth-invitations', 'auth-resource-session', 'project-settings', 'task-execution-time'] as const;
export const capacityScenarios = ['capacity-chain', 'capacity-merge', 'capacity-shared', 'capacity-external', 'capacity-limits'] as const;


export type AcceptanceScope = 'all' | 'native' | 'container';
export type AcceptanceTarget = Exclude<AcceptanceScope, 'all'>;
export const readAcceptanceScope = (value: unknown): AcceptanceScope => {
  if (value !== 'all' && value !== 'native' && value !== 'container') throw new Error('Invalid acceptance scope.');
  return value;
};
export const expectedTargets = (scope: AcceptanceScope): readonly AcceptanceTarget[] => scope === 'all' ? ['native', 'container'] : [scope];
export const browserDirectories = (scope: AcceptanceScope): readonly string[] => {
  const native = ['native/capacity', 'native/auth-combined', 'native/functional'];
  const container = ['container/auth-combined', 'container'];
  return scope === 'all' ? [native[0]!, ...container, ...native.slice(1)] : scope === 'native' ? native : container;
};
