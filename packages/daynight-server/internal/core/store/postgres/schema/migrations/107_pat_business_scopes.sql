ALTER TABLE personal_access_tokens ADD COLUMN business_scopes text[];
ALTER TABLE personal_access_tokens ADD COLUMN scope_version bigint;
ALTER TABLE device_authorizations ADD COLUMN approved_business_scopes text[];
