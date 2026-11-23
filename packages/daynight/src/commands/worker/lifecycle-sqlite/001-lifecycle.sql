CREATE TABLE lifecycle_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  server_origin TEXT NOT NULL,
  user_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  local_epoch INTEGER NOT NULL CHECK (local_epoch > 0),
  local_veto INTEGER NOT NULL CHECK (local_veto IN (0, 1)),
  intent_version INTEGER CHECK (intent_version > 0),
  desired TEXT CHECK (desired IN ('enabled', 'disabled')),
  admission TEXT NOT NULL CHECK (admission IN ('open', 'closed')),
  instance_id TEXT,
  instance_epoch INTEGER CHECK (instance_epoch > 0),
  scope_generation INTEGER NOT NULL CHECK (scope_generation > 0),
  phase TEXT NOT NULL CHECK (phase IN ('accepting', 'disabling', 'disabled', 'blocked', 'resuming')),
  active_operation_id TEXT,
  inventory_revision INTEGER NOT NULL CHECK (inventory_revision > 0),
  inventory_complete INTEGER NOT NULL CHECK (inventory_complete IN (0, 1)),
  bootstrap_consumed INTEGER NOT NULL CHECK (bootstrap_consumed IN (0, 1)),
  stop TEXT NOT NULL CHECK (stop IN ('not_started', 'stopping', 'confirmed', 'unknown')),
  save TEXT NOT NULL CHECK (save IN ('pending', 'durable', 'failed')),
  sync TEXT NOT NULL CHECK (sync IN ('pending', 'complete', 'failed')),
  error_code TEXT,
  activation_json TEXT,
  stop_proof_json TEXT
) STRICT;
CREATE TABLE lifecycle_operations (
  operation_id TEXT PRIMARY KEY,
  origin_operation_id TEXT,
  local_epoch INTEGER NOT NULL CHECK (local_epoch > 0),
  request_json TEXT,
  request_hash TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'submitted', 'unknown', 'confirmed', 'rejected')),
  receipt_json TEXT,
  activation_request_json TEXT,
  activation_request_hash TEXT,
  activation_status TEXT CHECK (activation_status IN ('prepared', 'submitted', 'unknown', 'confirmed', 'rejected')),
  activation_receipt_json TEXT
) STRICT;
CREATE TABLE resource_owners (
  resource_id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('task', 'bot', 'assistant', 'probe', 'repository', 'configuration', 'controller')),
  identity_json TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  instance_epoch INTEGER NOT NULL CHECK (instance_epoch > 0),
  scope_generation INTEGER NOT NULL CHECK (scope_generation > 0),
  admission_operation_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('reserved', 'running', 'stopped', 'not_dispatched', 'confirmed', 'unknown')),
  process_proof_json TEXT,
  stop_proof_json TEXT,
  save_state TEXT NOT NULL CHECK (save_state IN ('pending', 'durable', 'failed')),
  last_error TEXT
) STRICT;
CREATE TABLE lifecycle_outbox (
  id TEXT PRIMARY KEY,
  instance_epoch INTEGER NOT NULL CHECK (instance_epoch > 0),
  intent_version INTEGER NOT NULL CHECK (intent_version > 0),
  report_sequence INTEGER NOT NULL CHECK (report_sequence > 0),
  payload TEXT NOT NULL,
  hash TEXT NOT NULL,
  upload_state TEXT NOT NULL CHECK (upload_state IN ('pending', 'unknown', 'confirmed', 'covered', 'failed')),
  receipt_json TEXT,
  UNIQUE (instance_epoch, report_sequence)
) STRICT;
CREATE TABLE resource_history (
  resource_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  payload BLOB NOT NULL
) STRICT;
CREATE TABLE outbox_history (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  payload BLOB NOT NULL
) STRICT;
