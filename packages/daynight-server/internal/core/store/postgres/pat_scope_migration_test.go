package postgres

import (
	"slices"
	"testing"
)

func TestPATScopePreparationMigration(t *testing.T) {
	ctx := t.Context()
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 107 })
	if index < 1 {
		t.Fatal("PAT scope migration missing")
	}

	t.Run("historical startup and rollback", func(t *testing.T) {
		pool := emptyPool(t)
		if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
			t.Fatal(err)
		}
		_, err := pool.Exec(ctx, `
INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at,last_used_at)
VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',decode(repeat('01',32),'hex'),'old',now()-interval '2 hours',now()+interval '1 hour',now()-interval '1 hour');
INSERT INTO device_authorizations(id,device_code_hash,user_code,status,user_id,created_at,expires_at,next_poll_at,poll_interval_seconds)
VALUES ('00000000-0000-0000-0000-000000000003',decode(repeat('02',32),'hex'),'BCDFGHJKLM','approved','00000000-0000-0000-0000-000000000002',now()-interval '1 minute',now()+interval '1 hour',now(),5),
       ('00000000-0000-0000-0000-000000000004',decode(repeat('03',32),'hex'),'NPQRSTVWXZ','pending',NULL,now()-interval '1 minute',now()+interval '1 hour',now(),5)`)
		if err != nil {
			t.Fatal(err)
		}
		const indexQuery = `SELECT string_agg(indexname||'='||indexdef, E'\n' ORDER BY indexname) FROM pg_indexes WHERE schemaname=current_schema() AND tablename IN ('personal_access_tokens','device_authorizations')`
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
		if err := pool.QueryRow(ctx, `SELECT NOT EXISTS(SELECT FROM information_schema.columns WHERE table_schema=current_schema() AND column_name IN ('business_scopes','scope_version','approved_business_scopes') AND table_name IN ('personal_access_tokens','device_authorizations')) AND NOT EXISTS(SELECT FROM schema_migrations WHERE version=107)`).Scan(&ok); err != nil || !ok {
			t.Fatalf("failed migration left schema or ledger changes: %v %v", ok, err)
		}
		if err := initializeSchema(ctx, pool, schemaMigrations, currentSchemaSnapshot); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT (SELECT count(*)=1 AND bool_and(business_scopes IS NULL AND scope_version IS NULL AND name='old' AND encode(token_hash,'hex')=repeat('01',32) AND expires_at IS NOT NULL AND last_used_at IS NOT NULL) FROM personal_access_tokens) AND (SELECT count(*)=2 AND bool_and(approved_business_scopes IS NULL) AND count(*) FILTER (WHERE status='approved' AND user_id='00000000-0000-0000-0000-000000000002')=1 AND count(*) FILTER (WHERE status='pending' AND user_id IS NULL)=1 FROM device_authorizations)`).Scan(&ok); err != nil || !ok {
			t.Fatalf("historical facts changed: %v %v", ok, err)
		}
		if err := pool.QueryRow(ctx, indexQuery).Scan(&after); err != nil || before != after {
			t.Fatalf("indexes changed: %v", err)
		}
	})

	t.Run("empty startup and existing writers", func(t *testing.T) {
		pool := emptyPool(t)
		if err := initializeSchema(ctx, pool, schemaMigrations, currentSchemaSnapshot); err != nil {
			t.Fatal(err)
		}
		_, err := pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',decode(repeat('01',32),'hex'),'new',now()); INSERT INTO device_authorizations(id,device_code_hash,user_code,status,created_at,expires_at,next_poll_at,poll_interval_seconds) VALUES ('00000000-0000-0000-0000-000000000003',decode(repeat('02',32),'hex'),'BCDFGHJKLM','pending',now(),now()+interval '1 hour',now(),5)`)
		if err != nil {
			t.Fatal(err)
		}
		var ok bool
		if err := pool.QueryRow(ctx, `SELECT (SELECT business_scopes IS NULL AND scope_version IS NULL FROM personal_access_tokens) AND (SELECT approved_business_scopes IS NULL FROM device_authorizations) AND EXISTS(SELECT FROM schema_migrations WHERE version=107)`).Scan(&ok); err != nil || !ok {
			t.Fatalf("preparation defaults or ledger incorrect: %v %v", ok, err)
		}
	})
}
