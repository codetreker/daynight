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
	loadCoverageSchema(t, ctx, conn)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
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

func TestCoverageWriteFailuresRemainTransactional(t *testing.T) {
	ctx := t.Context()
	conn, err := pgx.Connect(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	loadCoverageSchema(t, ctx, conn)
	project := uuid.NewString()
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if _, err = conn.Exec(ctx, `INSERT INTO project_github_coverage(project_id,repository_id,started_at) VALUES($1,9,$2)`, project, start); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name    string
		enabled bool
		at      time.Time
		rename  bool
	}{
		{"reopen query fails", true, start.Add(time.Second), true},
		{"duplicate open rejected", true, start.Add(time.Second), false},
		{"close query fails", false, start.Add(time.Second), true},
		{"invalid close rejected", false, start.Add(-time.Second), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tx, err := conn.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if tc.rename {
				if _, err = tx.Exec(ctx, `ALTER TABLE project_github_coverage RENAME TO inaccessible_coverage`); err != nil {
					t.Fatal(err)
				}
			}
			if err = setCoverage(ctx, tx, project, 9, tc.enabled, tc.at); err == nil {
				t.Fatal("invalid coverage write succeeded")
			}
			if err = tx.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			var intact bool
			if err = conn.QueryRow(ctx, `SELECT count(*)=1 AND bool_and(started_at=$2 AND ended_at IS NULL) FROM project_github_coverage WHERE project_id=$1`, project, start).Scan(&intact); err != nil || !intact {
				t.Fatalf("failed transition changed period: %v %v", intact, err)
			}
		})
	}
}

func loadCoverageSchema(t *testing.T, ctx context.Context, conn *pgx.Conn) {
	t.Helper()
	snapshot, err := os.ReadFile("../schema/current.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, string(snapshot)); err != nil {
		t.Fatal(err)
	}
}
