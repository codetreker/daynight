CREATE TABLE bot_history_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  window_revision INTEGER NOT NULL CHECK(window_revision > 0),
  through_seq INTEGER NOT NULL CHECK(through_seq >= 0),
  display_through_seq INTEGER NOT NULL CHECK(display_through_seq >= 0),
  omitted INTEGER NOT NULL CHECK(omitted IN (0, 1))
) STRICT;

CREATE TABLE bot_history_identity (
  id TEXT PRIMARY KEY,
  entry_seq INTEGER NOT NULL UNIQUE CHECK(entry_seq > 0),
  turn_seq INTEGER NOT NULL CHECK(turn_seq >= 0),
  source_hash TEXT NOT NULL,
  preview TEXT,
  summarized INTEGER NOT NULL DEFAULT 0 CHECK(summarized IN (0, 1)),
  preview_bytes INTEGER NOT NULL DEFAULT 0 CHECK(preview_bytes >= 0),
  checkpoint_bytes INTEGER NOT NULL DEFAULT 0 CHECK(checkpoint_bytes >= 0)
) STRICT;

CREATE INDEX bot_history_visible ON bot_history_identity(entry_seq) WHERE preview IS NOT NULL;
CREATE INDEX bot_history_image_positions ON image_occurrences(json_extract(occurrence,'$.entryId'));
CREATE INDEX bot_history_capture_entry ON image_runtime_state(json_extract(value,'$.request.occurrence.entryId')) WHERE key GLOB 'capture:*';

CREATE TABLE bot_resource_retirement (resource_id TEXT PRIMARY KEY) STRICT;
