export const functionalScenarios = ['project-list', 'project-graph', 'detail-navigation', 'refresh-staleness',
  'failure-recovery', 'deep-links', 'keyboard-focus', 'narrow-layout', 'task-attachments', 'task-detail-page', 'project-view-tabs',
  'language-startup-preferences', 'language-state-preservation', 'language-errors-and-narrow',
  'task-description-markdown', 'task-status', 'task-status-conflicts', 'task-status-recovery', 'task-status-transitions', 'task-agent-permission', 'task-platform', 'task-assignment', 'task-assignment-layout',
  'auth-login-session', 'auth-project-isolation', 'auth-project-members', 'auth-personal-tokens',
  'auth-invitations', 'auth-resource-session', 'project-settings', 'task-execution-time', 'task-pause', 'task-step-status', 'task-step-access-retirement', 'task-step-position', 'task-step-add', 'task-step-edit', 'task-step-delete', 'assistant-composition'] as const;

export const authCombinedChecks = ['partial-sharing', 'normal-member-writes', 'bilingual-token', 'same-data-cli-browser',
  'restart-original-state', 'logout-independent-pat', 'pat-revocation', 'socket-disconnect',
  'admitted-member-removal', 'expired-pat', 'secret-scan'] as const;
