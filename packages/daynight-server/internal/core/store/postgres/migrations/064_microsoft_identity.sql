DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM users
        WHERE (uniauth_id LIKE 'microsoft:%' AND uniauth_id !~ '^microsoft:[^:@]+:[^:@]+$')
           OR (uniauth_id LIKE 'msft:%' AND uniauth_id !~ '^msft:[^:@]+@[^:@]+$')
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P1064',
            MESSAGE = 'Microsoft identity keys must contain nonempty oid and tid components without colon or at-sign delimiters';
    END IF;
END $$;

UPDATE users
SET uniauth_id = regexp_replace(uniauth_id, '^microsoft:([^:@]+):([^:@]+)$', 'msft:\2@\1')
WHERE uniauth_id LIKE 'microsoft:%';
