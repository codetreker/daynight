ALTER TABLE bots ADD CONSTRAINT bots_session_owner UNIQUE (id, owner_user_id);

ALTER TABLE task_sessions
 ADD COLUMN bot_id uuid,
 ADD CONSTRAINT session_bot_identity UNIQUE (bot_id),
 ADD CONSTRAINT session_bot_owner FOREIGN KEY (bot_id, owner_user_id) REFERENCES bots(id, owner_user_id),
 ADD CONSTRAINT session_bot_scope CHECK (bot_id IS NULL OR (scope='test' AND backend='web'));
