CREATE TABLE leases (
  native_key TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  launcher_proof TEXT NOT NULL,
  created_at TEXT NOT NULL
);
