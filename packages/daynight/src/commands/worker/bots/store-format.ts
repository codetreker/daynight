import type { SqliteFormat } from "../../../platform/sqlite-format.js";

const tables = {
  bot_identity: "CREATE TABLE bot_identity (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), server_origin TEXT NOT NULL, owner_user_id TEXT NOT NULL, bot_id TEXT NOT NULL) STRICT",
  bots: "CREATE TABLE bots (server_origin TEXT NOT NULL, owner_user_id TEXT NOT NULL, worker_id TEXT NOT NULL, bot_id TEXT NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)), PRIMARY KEY(server_origin, owner_user_id, worker_id, bot_id)) STRICT",
  bot_executions: "CREATE TABLE bot_executions (server_origin TEXT NOT NULL, owner_user_id TEXT NOT NULL, worker_id TEXT NOT NULL, bot_id TEXT NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)), PRIMARY KEY(server_origin, owner_user_id, worker_id, bot_id)) STRICT",
};
export const botStoreFormat: SqliteFormat = {
  name: "Bot state",
  baseline: { version: 1, create: db => { for (const sql of Object.values(tables)) db.exec(sql); } },
  // Version 1 writers discard the migration execution fence when observing a Bot.
  migrations: [{ toVersion: 2, up: () => undefined }],
  validateVersioned: (db, version) => {
    const objects = db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as { name: string; type: string; sql: string }[];
    if (![1, 2].includes(version) || objects.length !== Object.keys(tables).length || objects.some(object => object.type !== "table" || object.sql !== tables[object.name as keyof typeof tables])) {
      throw new Error("The Bot SQLite schema is incompatible with its known format.");
    }
  },
};
