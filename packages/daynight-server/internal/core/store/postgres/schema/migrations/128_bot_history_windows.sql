CREATE TABLE bot_history_windows (
 session_id uuid PRIMARY KEY,
 checkpoint jsonb NOT NULL
);
CREATE TABLE bot_history_reclaims (
 session_id uuid NOT NULL,
 resource_id uuid NOT NULL,
 PRIMARY KEY(session_id,resource_id)
);
