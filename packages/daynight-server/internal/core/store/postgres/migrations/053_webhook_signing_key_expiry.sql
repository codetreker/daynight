CREATE INDEX webhook_signing_keys_overlap_expiry
    ON webhook_signing_keys (overlap_until, endpoint_id, id) WHERE slot = 'overlap';
