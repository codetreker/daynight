-- The source-row removal and its receipt share one commit. Older Worker
-- writers cannot reopen this format and recreate the retired Bot authority.
CREATE TABLE bot_migrations (
  server_origin TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  PRIMARY KEY (server_origin, owner_user_id, worker_id, bot_id)
) STRICT;
