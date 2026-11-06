CREATE TABLE oauth_credential_cleanup_cursor (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    next_kind smallint NOT NULL CHECK (next_kind BETWEEN 0 AND 2)
);
INSERT INTO oauth_credential_cleanup_cursor (singleton, next_kind) VALUES (true, 0);

CREATE TABLE oauth_authorization_cleanup_cursor (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    next_kind smallint NOT NULL CHECK (next_kind BETWEEN 0 AND 1)
);
INSERT INTO oauth_authorization_cleanup_cursor (singleton, next_kind) VALUES (true, 0);
