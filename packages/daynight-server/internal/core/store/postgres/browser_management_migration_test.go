package postgres

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
)

func TestBrowserManagementMigrationPreservesLegacySessions(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 120 })
	if index < 2 || schemaMigrations[index-1].version != 119 || schemaMigrations[index-2].version != 118 {
		t.Fatal("browser management must follow activity and Step Webhook retirement migrations")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	project, err := testutil.CreateProject(ctx, pool, &Store{Pool: pool}, queryID(975), "Historical fixture", "https://example.test/fixture")
	if err != nil || project.ID != queryID(975) {
		t.Fatalf("schema 119 project fixture: %+v %v", project, err)
	}
	user, session := queryID(971), queryID(972)
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,'management-migration',now(),now())`, user); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sessions(id,user_id,token_hash,preview_token_hash,created_at,last_used_at,expires_at) VALUES($1,$2,decode(repeat('01',32),'hex'),decode(repeat('02',32),'hex'),now()-interval '1 hour',now()-interval '5 minutes',now()+interval '1 hour')`, session, user); err != nil {
		t.Fatal(err)
	}
	var before, activityChecksum, retirementChecksum string
	if err := pool.QueryRow(ctx, `SELECT to_jsonb(s)::text,(SELECT checksum FROM schema_migrations WHERE version=118),(SELECT checksum FROM schema_migrations WHERE version=119) FROM sessions s WHERE id=$1`, session).Scan(&before, &activityChecksum, &retirementChecksum); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	var after, checksum, retirementAfter string
	var unknown, indexes bool
	if err := pool.QueryRow(ctx, `SELECT (to_jsonb(s)-'browser'-'os')::text,browser IS NULL AND os IS NULL,(SELECT checksum FROM schema_migrations WHERE version=118),(SELECT checksum FROM schema_migrations WHERE version=119),to_regclass('sessions_user_created_id') IS NOT NULL AND to_regclass('sessions_expiry') IS NOT NULL AND to_regclass('sessions_preview_token_hash') IS NOT NULL AND to_regclass('sessions_token_hash_key') IS NOT NULL FROM sessions s WHERE id=$1`, session).Scan(&after, &unknown, &checksum, &retirementAfter, &indexes); err != nil {
		t.Fatal(err)
	}
	if before != after || !unknown || activityChecksum != checksum || retirementChecksum != retirementAfter || retirementAfter != schemaMigrations[index-1].checksum() || !indexes {
		t.Fatalf("legacy session changed: unknown=%v indexes=%v", unknown, indexes)
	}
	if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
}
