package postgres

import (
	"slices"
	"testing"
)

func TestCredentialDescriptionMigrationPreservesRows(t *testing.T) {
	pool := emptyPool(t)
	ctx := t.Context()
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 105 })
	if index < 1 {
		t.Fatal("migration missing")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',decode(repeat('00',32),'hex'),'old',now()); INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at) VALUES('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002','client','{}','resource','scope',now(),now()+interval '1 hour')`); err != nil {
		t.Fatal(err)
	}
	indexQuery := `SELECT string_agg(indexname||'='||indexdef, E'\n' ORDER BY indexname) FROM pg_indexes WHERE schemaname=current_schema() AND tablename IN ('personal_access_tokens','oauth_grants')`
	var before, after string
	if err := pool.QueryRow(ctx, indexQuery).Scan(&before); err != nil {
		t.Fatal(err)
	}
	broken := append([]migration(nil), schemaMigrations...)
	broken[index].sql += "\nSELECT 1 / 0;"
	if err := migrate(ctx, pool, broken); err == nil {
		t.Fatal("faulted migration succeeded")
	}
	var absent bool
	if err := pool.QueryRow(ctx, `SELECT NOT EXISTS(SELECT FROM information_schema.columns WHERE table_schema=current_schema() AND table_name IN ('personal_access_tokens','oauth_grants') AND column_name='description') AND NOT EXISTS(SELECT FROM schema_migrations WHERE version=105)`).Scan(&absent); err != nil || !absent {
		t.Fatalf("migration failure was not rolled back: %v %v", absent, err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var ok bool
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*)=1 AND bool_and(description IS NULL AND name='old' AND encode(token_hash,'hex')=repeat('00',32)) FROM personal_access_tokens) AND (SELECT count(*)=1 AND bool_and(description IS NULL AND client_id='client' AND resource='resource' AND scope='scope') FROM oauth_grants)`).Scan(&ok); err != nil || !ok {
		t.Fatalf("migration lost rows or null defaults: %v %v", ok, err)
	}
	if err := pool.QueryRow(ctx, indexQuery).Scan(&after); err != nil || before != after {
		t.Fatalf("indexes changed: %v", err)
	}
}
