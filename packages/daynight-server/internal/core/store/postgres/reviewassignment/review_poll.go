package reviewassignment

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func (s *DAO) ReviewPollWorker(ctx context.Context, userID, workerID string) (*store.ReviewPollWorker, error) {
	var result store.ReviewPollWorker
	err := s.db.QueryRow(ctx, `SELECT review_enabled,desired_configuration FROM workers WHERE user_id=$1 AND worker_id=$2`, userID, workerID).
		Scan(&result.ReviewEnabled, &result.DesiredConfiguration)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, pg.QueryError("read review polling worker", err)
	}
	return &result, nil
}

// Project access and all eligibility filters precede ordering and the limit.
// The snapshot caller has already interpreted the selected Project IDs in Go.
const reviewPollBaseSQL = `SELECT a.project_id::text,a.repository_id,a.github_pr_id,g.repository_full_name,p.number
 FROM project_pr_review_assignments a
 JOIN project_github g ON g.project_id=a.project_id AND g.repository_id=a.repository_id
 JOIN project_pull_requests p ON p.project_id=a.project_id AND p.repository_id=a.repository_id AND p.github_id=a.github_pr_id
 JOIN (` + pg.ProjectAccessRelation + `) access ON access.project_id=a.project_id AND access.user_id=a.user_id
 WHERE a.user_id=$1 AND a.worker_id=$2 AND a.project_id=ANY($3::uuid[])
   AND p.state='open' AND p.base_ref=g.repository_default_branch`

func reviewPollSQL(hasAfter bool) string {
	if hasAfter {
		return reviewPollBaseSQL + ` AND (a.project_id,a.repository_id,a.github_pr_id)>($4::uuid,$5::bigint,$6::bigint)
 ORDER BY a.project_id,a.repository_id,a.github_pr_id LIMIT $7`
	}
	return reviewPollBaseSQL + ` ORDER BY a.project_id,a.repository_id,a.github_pr_id LIMIT $4`
}

func (s *DAO) ReviewPollCandidates(ctx context.Context, userID, workerID string, projectIDs []string, after *store.ReviewPollKey, limit int) ([]store.ReviewPollCandidate, error) {
	args := []any{userID, workerID, projectIDs}
	if after != nil {
		args = append(args, after.ProjectID, after.RepositoryID, after.GitHubPRID)
	}
	args = append(args, limit)
	rows, err := s.db.Query(ctx, reviewPollSQL(after != nil), args...)
	if err != nil {
		return nil, pg.QueryError("list review polling candidates", err)
	}
	defer rows.Close()
	result := []store.ReviewPollCandidate{}
	for rows.Next() {
		var candidate store.ReviewPollCandidate
		if err := rows.Scan(&candidate.ProjectID, &candidate.RepositoryID, &candidate.GitHubPRID, &candidate.RepositoryFullName, &candidate.Number); err != nil {
			return nil, pg.QueryError("scan review polling candidate", err)
		}
		result = append(result, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("list review polling candidates", err)
	}
	return result, nil
}
