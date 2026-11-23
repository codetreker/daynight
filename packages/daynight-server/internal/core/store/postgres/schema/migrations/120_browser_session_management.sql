ALTER TABLE sessions ADD COLUMN browser text;
ALTER TABLE sessions ADD COLUMN os text;
CREATE INDEX sessions_user_created_id ON sessions (user_id, created_at DESC, id DESC);
