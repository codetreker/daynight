CREATE TABLE review_publications (
  review_id TEXT PRIMARY KEY,
  phase TEXT NOT NULL CHECK(phase IN ('prepared', 'pending', 'verified', 'legacy')),
  identity_format TEXT NOT NULL DEFAULT 'line' CHECK(identity_format IN ('line', 'legacy')),
  publisher_id TEXT CHECK(phase = 'legacy' OR identity_format = 'legacy' OR publisher_id IS NOT NULL),
  outcome TEXT CHECK(outcome IN ('approved', 'commented')),
  remote_review_id TEXT,
  remote_thread_ids TEXT NOT NULL DEFAULT '[]',
  followup_consumed INTEGER NOT NULL DEFAULT 0 CHECK(followup_consumed IN (0, 1)),
  CHECK((phase = 'verified') = (outcome IS NOT NULL AND remote_review_id IS NOT NULL))
) STRICT;

INSERT INTO review_publications(review_id, phase, identity_format)
SELECT id, CASE WHEN status = 'completed' THEN 'legacy' ELSE 'prepared' END, 'legacy'
FROM reviews WHERE status = 'completed' OR status IN ('preparing', 'running', 'retry_wait', 'interrupted');
