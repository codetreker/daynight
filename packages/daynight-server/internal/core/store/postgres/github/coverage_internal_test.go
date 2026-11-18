package github

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestCoverageSameSecondTransitions(t *testing.T) {
	ctx := t.Context()
	conn, err := pgx.Connect(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `CREATE TABLE project_github(project_id uuid, repository_id bigint, enabled boolean, sync_enabled boolean, revision bigint, last_full_generation bigint, access_state text, next_poll_at timestamptz, updated_at timestamptz)`); err != nil {
		t.Fatal(err)
	}
	schema, err := os.ReadFile("../schema/migrations/087_github_coverage.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, string(schema)); err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	change := func(enabled bool, at time.Time) {
		t.Helper()
		if err := setCoverage(ctx, tx, id, 9, enabled, at); err != nil {
			t.Fatal(err)
		}
	}
	count := func() int {
		t.Helper()
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM project_github_coverage WHERE project_id=$1`, id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	change(true, at)
	change(false, at)
	if n := count(); n != 0 {
		t.Fatalf("same-second stop retained %d periods", n)
	}
	change(true, at)
	change(false, at.Add(time.Second))
	change(true, at.Add(time.Second))
	change(false, at.Add(time.Second))
	change(true, at.Add(time.Second))
	var start time.Time
	var end *time.Time
	if err = tx.QueryRow(ctx, `SELECT started_at,ended_at FROM project_github_coverage WHERE project_id=$1`, id).Scan(&start, &end); err != nil || count() != 1 || !start.Equal(at) || end != nil {
		t.Fatalf("coalesced interval start=%v end=%v count=%d err=%v", start, end, count(), err)
	}
	change(false, at.Add(2*time.Second))
	change(true, at.Add(3*time.Second))
	if n := count(); n != 2 {
		t.Fatalf("distinct intervals = %d", n)
	}
}
