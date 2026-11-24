package postgres

import "testing"

func TestBotHistoryWindowMigrationPreservesExistingSession(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	bootstrapBaseline(t, pool)
	migrateTo(t, pool, 127)

	session := queryID(128)
	if _, err := pool.Exec(ctx, `INSERT INTO task_sessions
		(id,scope,test_execution_id,owner_user_id,registration_id,registration,snapshot,
		 source_epoch,last_source_seq,source_recovery_count)
		VALUES ($1,'test',$2,$3,$4,'{}','{"lifecycle":"archived"}',$5,7,2)`,
		session, queryID(129), queryID(130), queryID(131), queryID(132)); err != nil {
		t.Fatal(err)
	}
	var before string
	var windowTable, reclaimTable bool
	if err := pool.QueryRow(ctx, `SELECT to_jsonb(s)::text,
		to_regclass('bot_history_windows') IS NOT NULL,
		to_regclass('bot_history_reclaims') IS NOT NULL
		FROM task_sessions s WHERE id=$1`, session).Scan(&before, &windowTable, &reclaimTable); err != nil {
		t.Fatal(err)
	}
	if windowTable || reclaimTable {
		t.Fatal("Bot history tables exist before their migration")
	}

	migrateTo(t, pool, 128)

	var after, checksum string
	var windows, reclaims, receipts int
	if err := pool.QueryRow(ctx, `SELECT to_jsonb(s)::text,
		to_regclass('bot_history_windows') IS NOT NULL,
		to_regclass('bot_history_reclaims') IS NOT NULL,
		(SELECT count(*) FROM bot_history_windows),
		(SELECT count(*) FROM bot_history_reclaims),
		(SELECT count(*) FROM schema_migrations WHERE version=128),
		(SELECT checksum FROM schema_migrations WHERE version=128)
		FROM task_sessions s WHERE id=$1`, session).Scan(
		&after, &windowTable, &reclaimTable, &windows, &reclaims, &receipts, &checksum); err != nil {
		t.Fatal(err)
	}
	applied := migrationsThrough(128)
	if after != before || !windowTable || !reclaimTable || windows != 0 || reclaims != 0 || receipts != 1 || checksum != applied[len(applied)-1].checksum() {
		t.Fatalf("unexpected Bot history migration facts: session preserved=%v, tables=%v/%v, rows=%d/%d, receipts=%d, checksum=%s",
			after == before, windowTable, reclaimTable, windows, reclaims, receipts, checksum)
	}
}
