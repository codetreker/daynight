package postgres

import (
	"slices"
	"testing"
)

func TestOAuthScopePreparationMigration(t *testing.T) {
	ctx := t.Context()
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 109 })
	if index < 1 {
		t.Fatal("OAuth scope migration missing")
	}
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	_, err := pool.Exec(ctx, `INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at) VALUES
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','client','{}','https://example.test/mcp','daynight:mcp',now()-interval '1 hour',now()+interval '1 hour');
INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at) VALUES
('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',decode(repeat('01',32),'hex'),now()-interval '1 minute',now()+interval '30 minutes');
INSERT INTO oauth_authorizations(id,binding_hash,client_snapshot,client_id,redirect_uri,resource,scope,challenge,state,state_present,status,created_at,expires_at,retain_until) VALUES
('00000000-0000-0000-0000-000000000004',decode(repeat('02',32),'hex'),'{}','client','https://client.test','https://example.test/mcp','daynight:mcp','challenge','',false,'pending',now(),now()+interval '1 hour',now()+interval '1 day')`)
	if err != nil {
		t.Fatal(err)
	}
	const indexQuery = `SELECT string_agg(indexname||'='||indexdef, E'\n' ORDER BY indexname) FROM pg_indexes WHERE schemaname=current_schema() AND tablename IN ('oauth_grants','oauth_access_tokens','oauth_refresh_tokens','oauth_authorizations')`
	var before, after string
	if err := pool.QueryRow(ctx, indexQuery).Scan(&before); err != nil {
		t.Fatal(err)
	}
	broken := append([]migration(nil), schemaMigrations...)
	broken[index].sql += "\nSELECT 1 / 0;"
	if err := initializeSchema(ctx, pool, broken, currentSchemaSnapshot); err == nil {
		t.Fatal("faulted migration succeeded")
	}
	var ok bool
	if err := pool.QueryRow(ctx, `SELECT NOT EXISTS(SELECT FROM information_schema.columns WHERE table_schema=current_schema() AND ((table_name='oauth_grants' AND column_name IN ('business_scopes','scope_version')) OR (table_name='oauth_authorizations' AND column_name='approved_business_scopes'))) AND NOT EXISTS(SELECT FROM schema_migrations WHERE version=109)`).Scan(&ok); err != nil || !ok {
		t.Fatalf("failed migration left schema or ledger changes: %v %v", ok, err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM oauth_grants g JOIN oauth_access_tokens a ON a.grant_id=g.id WHERE g.id='00000000-0000-0000-0000-000000000001' AND a.token_hash=decode(repeat('01',32),'hex') AND g.business_scopes IS NULL AND g.scope_version IS NULL) AND EXISTS(SELECT FROM oauth_authorizations WHERE status='pending' AND approved_business_scopes IS NULL) AND EXISTS(SELECT FROM schema_migrations WHERE version=109)`).Scan(&ok); err != nil || !ok {
		t.Fatalf("historical OAuth facts changed: %v %v", ok, err)
	}
	if err := pool.QueryRow(ctx, indexQuery).Scan(&after); err != nil || before != after {
		t.Fatalf("OAuth indexes changed: %v", err)
	}
	empty := emptyPool(t)
	if err := migrate(ctx, empty, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	if err := empty.QueryRow(ctx, `SELECT EXISTS(SELECT FROM schema_migrations WHERE version=109) AND (SELECT count(*)=3 FROM information_schema.columns WHERE table_schema=current_schema() AND ((table_name='oauth_grants' AND column_name IN ('business_scopes','scope_version')) OR (table_name='oauth_authorizations' AND column_name='approved_business_scopes')))`).Scan(&ok); err != nil || !ok {
		t.Fatalf("empty schema missing OAuth scope preparation: %v %v", ok, err)
	}
}
