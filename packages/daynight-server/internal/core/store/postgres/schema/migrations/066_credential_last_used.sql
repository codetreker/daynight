ALTER TABLE personal_access_tokens ADD COLUMN last_used_at timestamptz;
ALTER TABLE oauth_grants ADD COLUMN last_used_at timestamptz;
