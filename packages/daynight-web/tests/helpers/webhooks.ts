export const webhookCatalog = (includeSteps = true) => ({
  items: ['task.created', 'task.status_changed', 'task.paused', 'task.deleted', ...(includeSteps ? ['task.step_updated'] : []), 'task.thread_posted'].map(key => ({ key, wireType: `cc.daynight.${key}.v1`, schemaVersion: 1, resourceKind: 'project' })),
  service: { configurationExpansionAvailable: true, dispatchEnabled: false },
  limits: { policyVersion: '1', requestBytes: 262144, payloadBytes: 65536, maxAutomaticAttempts: 8, automaticWindowSeconds: 86400, maxManualOperations: 3, payloadRetentionSeconds: 2592000, operationMaxAgeSeconds: 300, operationFutureSkewSeconds: 60 },
});
