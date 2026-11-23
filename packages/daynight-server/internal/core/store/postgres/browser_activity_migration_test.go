package postgres

import (
	"context"
	"slices"
	"testing"
	"time"
)

func TestBrowserActivityMigrationPreservesMainlineHistoryPolicyAndOldSession(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 115 })
	if index < 1 || schemaMigrations[index-1].version != 114 || schemaMigrations[index-1].sql != sessionHistoryPolicySQL {
		t.Fatal("browser activity must follow the published history policy migration")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	user, session := queryID(941), queryID(942)
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,'browser-migration',now(),now());`, user); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,decode(repeat('01',32),'hex'),clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour')`, session, user); err != nil {
		t.Fatal(err)
	}
	var before string
	if err := pool.QueryRow(ctx, `SELECT to_jsonb(s)::text FROM sessions s WHERE id=$1`, session).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	var after string
	var unknownActivity, historyPolicy bool
	if err := pool.QueryRow(ctx, `SELECT (to_jsonb(s)-'last_used_at')::text,last_used_at IS NULL,EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='task_sessions' AND column_name='history_content_policy') FROM sessions s WHERE id=$1`, session).Scan(&after, &unknownActivity, &historyPolicy); err != nil {
		t.Fatal(err)
	}
	if after != before || !unknownActivity || !historyPolicy {
		t.Fatal("browser activity migration changed old session facts or removed history policy")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatalf("reopening the complete migration ledger: %v", err)
	}
}
