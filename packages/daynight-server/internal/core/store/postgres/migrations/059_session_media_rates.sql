CREATE TABLE session_media_rates (
 owner_user_id uuid NOT NULL,
 category text NOT NULL,
 tokens bigint NOT NULL,
 updated_at timestamptz NOT NULL,
 PRIMARY KEY(owner_user_id,category)
);
