export const continuingWebhookEvents = ["task.created", "task.status_changed", "task.paused", "task.deleted", "task.thread_posted"];

export const webhookCatalog = (keys = continuingWebhookEvents) => ({
  items: keys.map(key => ({ key, wireType: `cc.daynight.${key}.v1`, schemaVersion: 1, resourceKind: "project" })),
  service: { configurationExpansionAvailable: true, dispatchEnabled: true },
  limits: { policyVersion: "1", requestBytes: 262_144, payloadBytes: 65_536, maxAutomaticAttempts: 8, automaticWindowSeconds: 86_400, maxManualOperations: 10, payloadRetentionSeconds: 604_800, operationMaxAgeSeconds: 300, operationFutureSkewSeconds: 60 },
});
