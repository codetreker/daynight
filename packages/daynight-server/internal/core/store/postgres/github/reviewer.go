package github

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

const reviewerEligibility = `
	w.review_enabled AND w.last_seen_at <= statement_timestamp()
	AND w.last_seen_at > statement_timestamp() - ($1::bigint * interval '1 microsecond')
	AND w.desired_configuration @> jsonb_build_object('projects', jsonb_build_array(jsonb_build_object('projectId', pr.project_id::text)))
	AND c.enabled AND c.sync_enabled AND c.access_state='available' AND pr.state='open'`

func AssignPullRequestReviewer(ctx context.Context, tx pgx.Tx, activeWindow time.Duration) (bool, error) {
	var projectID, userID, workerID string
	var githubID int64
	window := activeWindow.Microseconds()
	err := tx.QueryRow(ctx, `
		WITH assigned_counts AS (
			SELECT r.project_id, r.user_id, r.worker_id, count(*) AS assigned
			FROM project_pull_request_reviewers r
			JOIN project_pull_requests p ON p.project_id=r.project_id AND p.github_id=r.github_id AND p.state='open'
			GROUP BY r.project_id, r.user_id, r.worker_id
		)
		SELECT pr.project_id::text, pr.github_id, w.user_id::text, w.worker_id::text
		FROM workers w
		JOIN (`+pg.ProjectAccessRelation+`) access ON access.user_id=w.user_id
		JOIN project_github c ON c.project_id=access.project_id
		JOIN project_pull_requests pr ON pr.project_id=access.project_id
		LEFT JOIN project_pull_request_reviewers owner ON owner.project_id=pr.project_id AND owner.github_id=pr.github_id
		LEFT JOIN assigned_counts load ON load.project_id=pr.project_id AND load.user_id=w.user_id AND load.worker_id=w.worker_id
		WHERE `+reviewerEligibility+` AND owner.github_id IS NULL
		ORDER BY pr.github_created_at, pr.project_id, pr.number, COALESCE(load.assigned,0), w.user_id, w.worker_id
		LIMIT 1`, window).Scan(&projectID, &githubID, &userID, &workerID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, pg.QueryError("select pull request reviewer", err)
	}

	// Project mutations and GitHub publication lock the Project before their
	// own rows. Stabilize the same Project and the chosen access sources first.
	err = tx.QueryRow(ctx, `SELECT id::text FROM projects WHERE id=$1 AND deleted_at IS NULL
		FOR SHARE SKIP LOCKED`, projectID).Scan(&projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, pg.QueryError("lock reviewer Project", err)
	}
	if _, err := pg.LockProjectAuthorization(ctx, tx, userID, projectID); errors.Is(err, model.ErrNotFound) {
		return false, nil
	} else if err != nil {
		return false, err
	}

	result, err := tx.Exec(ctx, `
		WITH eligible AS (
			SELECT pr.project_id, pr.github_id, w.user_id, w.worker_id
			FROM project_pull_requests pr
			JOIN project_github c ON c.project_id=pr.project_id
			JOIN workers w ON w.user_id=$4 AND w.worker_id=$5
			WHERE pr.project_id=$2 AND pr.github_id=$3 AND `+reviewerEligibility+`
			FOR SHARE OF pr,c,w SKIP LOCKED
		)
		INSERT INTO project_pull_request_reviewers (project_id,github_id,user_id,worker_id,assigned_at)
		SELECT project_id,github_id,user_id,worker_id,statement_timestamp() FROM eligible
		ON CONFLICT (project_id,github_id) DO NOTHING`, window, projectID, githubID, userID, workerID)
	if err != nil {
		return false, pg.QueryError("assign pull request reviewer", err)
	}
	return result.RowsAffected() == 1, nil
}
