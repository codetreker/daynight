CREATE TABLE bots (
  server_origin TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  record TEXT NOT NULL CHECK(json_valid(record)),
  PRIMARY KEY(server_origin, owner_user_id, worker_id, bot_id)
) STRICT;
