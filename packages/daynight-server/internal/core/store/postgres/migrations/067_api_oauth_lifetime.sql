ALTER TABLE oauth_grants DROP CONSTRAINT oauth_grants_check;

ALTER TABLE oauth_grants ADD CONSTRAINT oauth_grants_lifetime_check CHECK (
    expires_at > created_at
    AND (
        (scope = 'daynight:api' AND client_id = 'societas-bot')
        OR expires_at <= created_at + interval '720 hours'
    )
);
