package postgres

import (
	"slices"
	"testing"
)

func TestReviewPollIndexesMigrationPreservesAssignments(t *testing.T) {
	pool := emptyPool(t)
	ctx := t.Context()
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 107 })
	if index < 1 {
		t.Fatal("migration missing")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO project_pr_review_assignments(user_id,project_id,repository_id,github_pr_id,worker_id,assigned_at)
		VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',3,4,'00000000-0000-4000-8000-000000000005',now())`); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var rows, indexes int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM project_pr_review_assignments WHERE repository_id=3 AND github_pr_id=4),
		(SELECT count(*) FROM pg_indexes WHERE schemaname=current_schema() AND indexname IN ('project_pr_review_assignments_worker_cursor','project_pull_requests_open_github_id'))`).Scan(&rows, &indexes); err != nil || rows != 1 || indexes != 2 {
		t.Fatalf("rows=%d indexes=%d error=%v", rows, indexes, err)
	}
}
