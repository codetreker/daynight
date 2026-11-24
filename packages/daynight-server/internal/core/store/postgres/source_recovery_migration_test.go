package postgres

import "testing"

func TestSourceRecoveryMigrationPreservesExistingSession(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	bootstrapBaseline(t, pool)
	migrateTo(t, pool, 126)

	session := queryID(127)
	if _, err := pool.Exec(ctx, `INSERT INTO task_sessions
		(id,scope,test_execution_id,owner_user_id,registration_id,registration,snapshot)
		VALUES ($1,'test',$2,$3,$4,'{}','{"lifecycle":"archived"}')`,
		session, queryID(128), queryID(129), queryID(130)); err != nil {
		t.Fatal(err)
	}
	var before string
	if err := pool.QueryRow(ctx, `SELECT to_jsonb(s)::text FROM task_sessions s WHERE id=$1`, session).Scan(&before); err != nil {
		t.Fatal(err)
	}

	migrateTo(t, pool, 127)

	var after, checksum string
	var recoveryCount, receipts int
	if err := pool.QueryRow(ctx, `SELECT
		(to_jsonb(s)-'source_recovery_count')::text,source_recovery_count,
		(SELECT count(*) FROM session_source_recoveries),
		(SELECT checksum FROM schema_migrations WHERE version=127)
		FROM task_sessions s WHERE id=$1`, session).Scan(&after, &recoveryCount, &receipts, &checksum); err != nil {
		t.Fatal(err)
	}
	applied := migrationsThrough(127)
	if after != before || recoveryCount != 0 || receipts != 0 || checksum != applied[len(applied)-1].checksum() {
		t.Fatalf("unexpected recovery migration facts: session preserved=%v, count=%d, receipts=%d, checksum=%s",
			after == before, recoveryCount, receipts, checksum)
	}
}
