package postgres

import (
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestGitHubCoverageRejectsOverlappingOpenPeriodsAndEmptyPeriods(t *testing.T) {
	ctx := t.Context()
	pool := isolatedStore(t).Pool
	active, disabled := queryID(101), queryID(103)
	now := time.Now().UTC().Truncate(time.Second)
	if _, err := pool.Exec(ctx, `INSERT INTO project_github_coverage(project_id,repository_id,started_at) VALUES($1,22,$2)`, active, now); err != nil {
		t.Fatal(err)
	}
	_, err := pool.Exec(ctx, `INSERT INTO project_github_coverage(project_id,repository_id,started_at) VALUES($1,22,$2)`, active, now.Add(time.Hour))
	var duplicate *pgconn.PgError
	if !errors.As(err, &duplicate) || duplicate.Code != "23505" {
		t.Fatalf("second open period was not rejected by the unique index: %v", err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO project_github_coverage(project_id,repository_id,started_at,ended_at) VALUES($1,99,$2,$2)`, disabled, now)
	var invalidPeriod *pgconn.PgError
	if !errors.As(err, &invalidPeriod) || invalidPeriod.Code != "23514" {
		t.Fatalf("empty period was not rejected by the check constraint: %v", err)
	}
}
