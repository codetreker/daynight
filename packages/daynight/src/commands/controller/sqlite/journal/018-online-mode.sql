ALTER TABLE execution ADD COLUMN online_mode TEXT CHECK(online_mode IN ('legacy', 'relay'));

-- Journals from older Controllers already use the legacy online protocol.
UPDATE execution SET online_mode='legacy';

-- Bind timeline revisions and native array positions to their original events;
-- migrated entries cannot manufacture either fact.
CREATE TABLE timeline_source_revisions (
  entry_id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  source_sequence TEXT NOT NULL,
  position_visible INTEGER NOT NULL CHECK(position_visible IN (0,1))
);
ALTER TABLE image_occurrences ADD COLUMN part_index INTEGER;
