ALTER TABLE worker_lifecycle DROP COLUMN instance_epoch;
ALTER TABLE worker_lifecycle_observations DROP COLUMN instance_epoch;

CREATE TEMP TABLE registered_worker_instances (
    user_id uuid NOT NULL,
    worker_id uuid NOT NULL,
    epoch text NOT NULL,
    instance_id uuid NOT NULL,
    PRIMARY KEY (user_id, worker_id, epoch)
) ON COMMIT DROP;

INSERT INTO registered_worker_instances (user_id, worker_id, epoch, instance_id)
SELECT user_id, worker_id, receipt->>'instanceEpoch', (request->>'instanceId')::uuid
FROM worker_lifecycle_operations
WHERE request_kind = 'instance' AND state = 'applied';

-- Lifecycle requests use ASCII keys and strings, integer numbers, and no arrays.
-- JSONB text orders keys differently from the protocol's canonical JSON.
CREATE FUNCTION pg_temp.lifecycle_canonical_request(document jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT CASE jsonb_typeof(document)
        WHEN 'object' THEN (
            SELECT '{' || coalesce(string_agg(
                to_jsonb(key)::text || ':' || pg_temp.lifecycle_canonical_request(value),
                ',' ORDER BY key COLLATE "C"), '') || '}'
            FROM jsonb_each(document)
        )
        ELSE document::text
    END
$$;

WITH rewritten AS (
    SELECT o.user_id, o.worker_id, o.operation_id, o.request_kind,
        CASE o.request_kind
            WHEN 'instance' THEN o.request - 'previousInstanceEpoch'
            WHEN 'activation' THEN o.request - 'instanceEpoch'
            ELSE CASE
                WHEN i.instance_id IS NOT NULL THEN
                    (o.request - 'instanceEpoch') || jsonb_build_object('instanceId', i.instance_id)
                WHEN o.state = 'not_committed' THEN
                    -- A resolution may reserve an operation ID for an epoch that was never registered.
                    -- A synthetic version 8 UUID preserves the tombstone without binding it to an active instance.
                    (o.request - 'instanceEpoch') || jsonb_build_object('instanceId',
                        overlay(overlay(md5('daynight.lifecycle.v1/unregistered/' || o.operation_id::text)
                            placing '8' from 13) placing '8' from 17)::uuid)
            END
        END AS request,
        CASE o.request_kind
            WHEN 'activation' THEN CASE
                WHEN o.state = 'not_committed' THEN o.receipt
                ELSE (o.receipt - 'instanceEpoch') || jsonb_build_object('instanceId', o.request->'instanceId')
            END
            ELSE o.receipt - 'instanceEpoch'
        END AS receipt,
        CASE WHEN o.activation IS NOT NULL THEN
            (o.activation - 'instanceEpoch') || jsonb_build_object('instanceId', o.activation_request->'instanceId')
        END AS activation,
        o.activation_request - 'instanceEpoch' AS activation_request
    FROM worker_lifecycle_operations o
    LEFT JOIN registered_worker_instances i
        ON o.request_kind = 'intent' AND o.action = 'resume'
        AND i.user_id = o.user_id AND i.worker_id = o.worker_id AND i.epoch = o.request->>'instanceEpoch'
    WHERE o.request_kind IN ('instance', 'activation') OR (o.request_kind = 'intent' AND o.action = 'resume')
), rehashed AS (
    SELECT r.*,
        sha256(convert_to('daynight.lifecycle.v1/' || r.request_kind || chr(10) ||
            pg_temp.lifecycle_canonical_request(r.request), 'UTF8')) AS request_hash,
        sha256(convert_to('daynight.lifecycle.v1/activation' || chr(10) ||
            pg_temp.lifecycle_canonical_request(r.activation_request), 'UTF8')) AS activation_hash
    FROM rewritten r
)
UPDATE worker_lifecycle_operations o
SET request = r.request,
    request_hash = r.request_hash,
    receipt = CASE WHEN o.state = 'not_committed' THEN
        jsonb_set(r.receipt, '{requestHash}', to_jsonb(encode(r.request_hash, 'hex')))
        ELSE r.receipt
    END,
    activation = r.activation,
    activation_request = r.activation_request,
    activation_hash = r.activation_hash
FROM rehashed r
WHERE (o.user_id, o.worker_id, o.operation_id) = (r.user_id, r.worker_id, r.operation_id);

UPDATE worker_lifecycle_observations SET observation = observation - 'instanceEpoch';

DROP FUNCTION pg_temp.lifecycle_canonical_request(jsonb);
