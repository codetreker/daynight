package postgres

import (
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestWorkerPlatformTaskModeMigration(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:len(schemaMigrations)-1]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	stamp := time.Date(2020, 1, 2, 0, 0, 0, 0, time.UTC)
	user := queryID(1)
	for i := 2; i <= 6; i++ {
		putWorkerSnapshot(t, db, workerSnapshotFixture(user, queryID(i), stamp))
	}
	observation := `{"baseRevision":"4","desiredRevision":"9","items":[{"key":{"kind":"preferPlatformSpecificTasks"},"targetRevision":"9","appliedValue":true,"state":"applied","error":null,"lastFailure":null,"nextAttemptAt":null}],"reportedAt":"2020-01-02T00:00:00Z"}`
	for i, old := range []bool{false, true} {
		mustQueryExec(t, db, `UPDATE workers SET configuration_revision=9,configuration_updated_at=$3,desired_configuration=jsonb_build_object('preferPlatformSpecificTasks',$4::boolean,'future',jsonb_build_object('nested',7)),configuration_observation_revision=5,configuration_observation=$5 WHERE user_id=$1 AND worker_id=$2`, user, queryID(i+2), stamp, old, observation)
	}
	for i, value := range []string{`{"platformTaskMode":"only","future":null}`, `{"future":{"nested":7}}`} {
		mustQueryExec(t, db, `UPDATE workers SET configuration_revision=9223372036854775807,configuration_updated_at=$3,desired_configuration=$4 WHERE user_id=$1 AND worker_id=$2`, user, queryID(i+5), stamp, value)
	}
	var untouchedBefore, untouchedAfter string
	untouched := `SELECT jsonb_agg(to_jsonb(w) ORDER BY worker_id)::text FROM workers w WHERE worker_id IN ($1,$2,$3)`
	if err := pool.QueryRow(ctx, untouched, queryID(4), queryID(5), queryID(6)).Scan(&untouchedBefore); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	for i, mode := range []string{"all", "prefer"} {
		var matches bool
		if err := pool.QueryRow(ctx, `SELECT desired_configuration=jsonb_build_object('platformTaskMode',$3::text,'future',jsonb_build_object('nested',7)) AND configuration_revision=10 AND configuration_updated_at>$4 AND configuration_observation_revision=5 AND configuration_observation=$5::jsonb FROM workers WHERE user_id=$1 AND worker_id=$2`, user, queryID(i+2), mode, stamp, observation).Scan(&matches); err != nil || !matches {
			t.Fatalf("mode %s migration differs: matches=%v err=%v", mode, matches, err)
		}
	}
	if err := pool.QueryRow(ctx, untouched, queryID(4), queryID(5), queryID(6)).Scan(&untouchedAfter); err != nil || untouchedBefore != untouchedAfter {
		t.Fatalf("migration changed uninitialized or non-boolean targets: %v", err)
	}
	var beforeReplay, afterReplay string
	all := `SELECT jsonb_agg(to_jsonb(w) ORDER BY worker_id)::text FROM workers w`
	if err := pool.QueryRow(ctx, all).Scan(&beforeReplay); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, all).Scan(&afterReplay); err != nil || beforeReplay != afterReplay {
		t.Fatalf("replay changed worker facts: %v", err)
	}
}

func TestWorkerPlatformTaskModeMigrationOverflowRollsBack(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:len(schemaMigrations)-1]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	user := queryID(1)
	for _, id := range []string{queryID(2), queryID(3)} {
		putWorkerSnapshot(t, db, workerSnapshotFixture(user, id, time.Now().UTC()))
	}
	mustQueryExec(t, db, `UPDATE workers SET configuration_revision=9,configuration_updated_at=now(),desired_configuration='{"preferPlatformSpecificTasks":true,"future":1}' WHERE user_id=$1`, user)
	mustQueryExec(t, db, `UPDATE workers SET configuration_revision=9223372036854775807 WHERE user_id=$1 AND worker_id=$2`, user, queryID(3))
	var before, after string
	all := `SELECT jsonb_agg(to_jsonb(w) ORDER BY worker_id)::text FROM workers w`
	if err := pool.QueryRow(ctx, all).Scan(&before); err != nil {
		t.Fatal(err)
	}
	err := migrate(ctx, pool, schemaMigrations)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "22003" {
		t.Fatalf("expected revision overflow, got %v", err)
	}
	var ledger int
	if err := pool.QueryRow(ctx, all).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version=119`).Scan(&ledger); err != nil || ledger != 0 || before != after {
		t.Fatalf("overflow changed rows or ledger: ledger=%d err=%v", ledger, err)
	}
}
