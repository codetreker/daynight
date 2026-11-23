ALTER TABLE oauth_grants ADD COLUMN business_scopes text[];
ALTER TABLE oauth_grants ADD COLUMN scope_version bigint;
ALTER TABLE oauth_authorizations ADD COLUMN approved_business_scopes text[];
