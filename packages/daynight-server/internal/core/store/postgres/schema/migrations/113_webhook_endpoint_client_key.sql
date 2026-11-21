-- A caller-chosen creation key identifies at most one live endpoint per owner.
-- Tombstones clear the key, so deletion releases it for a later create.
ALTER TABLE webhook_endpoints ADD COLUMN client_key text;

CREATE UNIQUE INDEX webhook_endpoints_live_client_key_idx
    ON webhook_endpoints (owner_kind, owner_id, client_key)
    WHERE deleted_at IS NULL AND client_key IS NOT NULL;
