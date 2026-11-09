CREATE TABLE session_media_rates (
 owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 category text NOT NULL CHECK (category IN ('prepare','control','observe','release')),
 tokens bigint NOT NULL CHECK (tokens BETWEEN 0 AND 40000000),
 updated_at timestamptz NOT NULL,
 PRIMARY KEY(owner_user_id,category)
);
