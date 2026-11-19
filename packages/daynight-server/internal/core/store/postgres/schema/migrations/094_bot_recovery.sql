CREATE TABLE bot_recovery (
    bot_id uuid PRIMARY KEY,
    worker_id uuid NOT NULL,
    service_origin text NOT NULL,
    machine_id text NOT NULL,
    machine_name text NOT NULL,
    identity_hash bytea NOT NULL,
    hosting_generation bigint NOT NULL
);

CREATE TABLE bot_recovery_operations (
    bot_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    kind text NOT NULL,
    request_hash bytea NOT NULL,
    receipt jsonb NOT NULL,
    PRIMARY KEY (bot_id, operation_id)
);

CREATE INDEX bot_recovery_operation_tokens
 ON bot_recovery_operations(bot_id,(receipt->>'controllerTokenHash'));
