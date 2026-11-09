LOCK TABLE login_transactions IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM login_transactions WHERE expires_at > clock_timestamp()) THEN
        RAISE EXCEPTION USING ERRCODE = 'P1047', MESSAGE = 'active login transactions must be consumed or expired before login scope migration';
    END IF;
END $$;

DELETE FROM login_transactions WHERE expires_at <= clock_timestamp();
ALTER TABLE login_transactions ADD COLUMN scope_hash bytea NOT NULL CHECK (octet_length(scope_hash) = 32);
CREATE INDEX login_transactions_scope_expiry ON login_transactions (scope_hash, expires_at);
