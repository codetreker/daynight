package pg

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// LockGoalDependencyTeam requires the local Project row lock. Ownership cannot
// change while that lock is held, and the graph lock must precede other row locks.
func LockGoalDependencyTeam(ctx context.Context, tx pgx.Tx, projectID string) error {
	var teamID string
	if err := tx.QueryRow(ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1`, projectID).Scan(&teamID); err != nil {
		return QueryError("read goal dependency owner", err)
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('goal-dependency-team:' || $1::uuid::text, 0))`, teamID); err != nil {
		return QueryError("lock goal dependency team", err)
	}
	return nil
}
