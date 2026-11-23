-- Preserve binding identities for queued deliveries and historical matches.
CREATE TEMP TABLE retired_step_webhook_bindings ON COMMIT DROP AS
SELECT b.id, b.subscription_id, s.endpoint_id
FROM webhook_bindings b
LEFT JOIN webhook_subscriptions s ON s.id = b.subscription_id
WHERE b.event_type = 'task.step_updated' AND b.deleted_at IS NULL;

UPDATE webhook_bindings b
SET deleted_at = statement_timestamp()
FROM retired_step_webhook_bindings r
WHERE b.id = r.id;

UPDATE webhook_subscriptions s
SET deleted_at = statement_timestamp(), updated_at = statement_timestamp()
WHERE s.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM retired_step_webhook_bindings r WHERE r.subscription_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM webhook_bindings b WHERE b.subscription_id = s.id AND b.deleted_at IS NULL);

UPDATE webhook_endpoints e
SET config_version = e.config_version + 1, updated_at = statement_timestamp()
WHERE EXISTS (SELECT 1 FROM retired_step_webhook_bindings r WHERE r.endpoint_id = e.id);
