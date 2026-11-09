ALTER TABLE webhook_operations DROP CONSTRAINT webhook_operations_kind_check;
ALTER TABLE webhook_operations ADD CONSTRAINT webhook_operations_kind_check
    CHECK (kind IN ('endpoint.create', 'endpoint.patch', 'endpoint.delete', 'signing-secret.rotate', 'delivery.redeliver'));
ALTER TABLE webhook_operations ADD COLUMN delivery_id uuid;
ALTER TABLE webhook_operations ADD COLUMN generation_after bigint;
ALTER TABLE webhook_operations ADD CONSTRAINT webhook_operations_redelivery_check
    CHECK ((kind = 'delivery.redeliver' AND delivery_id IS NOT NULL AND generation_after IS NOT NULL AND generation_after > 0)
        OR (kind <> 'delivery.redeliver' AND delivery_id IS NULL AND generation_after IS NULL));
CREATE INDEX webhook_operations_delivery ON webhook_operations (delivery_id, expires_at, operation_id) WHERE delivery_id IS NOT NULL;
