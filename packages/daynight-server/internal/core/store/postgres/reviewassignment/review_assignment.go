package reviewassignment

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
	"time"
)

type queryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}
type DAO struct {
	db        queryer
	tx        pgx.Tx
	projectID string
}

func NewReader(db queryer) *DAO                  { return &DAO{db: db} }
func NewWriter(tx pgx.Tx, projectID string) *DAO { return &DAO{db: tx, tx: tx, projectID: projectID} }

func (s *DAO) ReviewAssignment(ctx context.Context, userID, projectID string, repositoryID, githubPRID int64) (*store.ReviewAssignment, error) {
	var result store.ReviewAssignment
	err := s.db.QueryRow(ctx, `SELECT a.worker_id::text,a.assigned_at,w.last_seen_at,w.review_enabled
        FROM project_pr_review_assignments a LEFT JOIN workers w ON w.user_id=a.user_id AND w.worker_id=a.worker_id
        WHERE a.user_id=$1 AND a.project_id=$2 AND a.repository_id=$3 AND a.github_pr_id=$4`, userID, projectID, repositoryID, githubPRID).
		Scan(&result.WorkerID, &result.AssignedAt, &result.LastSeenAt, &result.ReviewEnabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, pg.QueryError("read review assignment", err)
	}
	result.AssignedAt = result.AssignedAt.UTC()
	if result.LastSeenAt != nil {
		t := result.LastSeenAt.UTC()
		result.LastSeenAt = &t
	}
	return &result, nil
}

func (s *DAO) ReviewScanStart(ctx context.Context) (time.Time, *store.ReviewWorkerKey, error) {
	var now time.Time
	var userID, workerID *string
	err := s.db.QueryRow(ctx, `SELECT statement_timestamp(), w.user_id::text, w.worker_id::text
        FROM (SELECT 1) x LEFT JOIN LATERAL (SELECT user_id,worker_id FROM workers WHERE review_enabled ORDER BY user_id DESC,worker_id DESC LIMIT 1) w ON true`).Scan(&now, &userID, &workerID)
	if err != nil {
		return time.Time{}, nil, pg.QueryError("start review scan", err)
	}
	if userID == nil {
		return now.UTC(), nil, nil
	}
	return now.UTC(), &store.ReviewWorkerKey{UserID: *userID, WorkerID: *workerID}, nil
}

const reviewWorkersSQL = `SELECT user_id::text,worker_id::text,created_at,last_seen_at,review_enabled,desired_configuration FROM workers
        WHERE review_enabled AND created_at <= $1 AND (user_id,worker_id)<=($2::uuid,$3::uuid)
        AND ($4::uuid IS NULL OR (user_id,worker_id)>($4::uuid,$5::uuid)) ORDER BY workers.user_id,workers.worker_id LIMIT $6`

func (s *DAO) ReviewWorkers(ctx context.Context, start time.Time, upper store.ReviewWorkerKey, after *store.ReviewWorkerKey, limit int) ([]store.ReviewWorker, error) {
	var afterUser, afterWorker any
	if after != nil {
		afterUser, afterWorker = after.UserID, after.WorkerID
	}
	rows, err := s.db.Query(ctx, reviewWorkersSQL, start, upper.UserID, upper.WorkerID, afterUser, afterWorker, limit)
	if err != nil {
		return nil, pg.QueryError("list review workers", err)
	}
	defer rows.Close()
	result := []store.ReviewWorker{}
	for rows.Next() {
		var w store.ReviewWorker
		if err := rows.Scan(&w.UserID, &w.WorkerID, &w.CreatedAt, &w.LastSeenAt, &w.ReviewEnabled, &w.DesiredConfiguration); err != nil {
			return nil, pg.QueryError("scan review worker", err)
		}
		result = append(result, w)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("list review workers", err)
	}
	return result, nil
}

func (s *DAO) ReviewRepository(ctx context.Context, projectID string) (*int64, error) {
	var id *int64
	err := s.db.QueryRow(ctx, `SELECT repository_id FROM project_github WHERE project_id=$1`, projectID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, pg.QueryError("read review repository", err)
	}
	return id, nil
}

const reviewOpenPRsSQL = `SELECT p.number,p.github_id,p.state,(a.found IS NOT NULL)
        FROM project_pull_requests p LEFT JOIN LATERAL (
            SELECT 1 AS found FROM project_pr_review_assignments a
            WHERE a.user_id=$1 AND a.project_id=p.project_id AND a.repository_id=p.repository_id AND a.github_pr_id=p.github_id LIMIT 1
        ) a ON true
        WHERE p.project_id=$2 AND p.repository_id=$3 AND p.state='open' AND ($4::bigint IS NULL OR p.number<=$4) AND ($5::bigint IS NULL OR p.number<$5) ORDER BY p.number DESC LIMIT $6`

func (s *DAO) ReviewOpenPRs(ctx context.Context, userID, projectID string, repositoryID int64, upper, after *int64, limit int) ([]store.ReviewPR, error) {
	rows, err := s.db.Query(ctx, reviewOpenPRsSQL, userID, projectID, repositoryID, upper, after, limit)
	if err != nil {
		return nil, pg.QueryError("list review PRs", err)
	}
	defer rows.Close()
	result := []store.ReviewPR{}
	for rows.Next() {
		var p store.ReviewPR
		if err := rows.Scan(&p.Number, &p.GitHubID, &p.State, &p.Assigned); err != nil {
			return nil, pg.QueryError("scan review PR", err)
		}
		result = append(result, p)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("list review PRs", err)
	}
	return result, nil
}

func (w *DAO) LockAuthorization(ctx context.Context, userID string) (model.ProjectAccess, error) {
	return pg.LockProjectAuthorization(ctx, w.tx, userID, w.projectID)
}
func (w *DAO) LockConnection(ctx context.Context) (*int64, error) {
	var id *int64
	err := w.tx.QueryRow(ctx, `SELECT repository_id FROM project_github WHERE project_id=$1 FOR SHARE`, w.projectID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, pg.QueryError("lock review connection", err)
	}
	return id, nil
}
func (w *DAO) LockWorker(ctx context.Context, userID, workerID string) (store.ReviewWorker, error) {
	var v store.ReviewWorker
	err := w.tx.QueryRow(ctx, `SELECT user_id::text,worker_id::text,created_at,last_seen_at,review_enabled,desired_configuration FROM workers WHERE user_id=$1 AND worker_id=$2 FOR SHARE`, userID, workerID).Scan(&v.UserID, &v.WorkerID, &v.CreatedAt, &v.LastSeenAt, &v.ReviewEnabled, &v.DesiredConfiguration)
	if err != nil {
		return store.ReviewWorker{}, pg.QueryError("lock review worker", err)
	}
	return v, nil
}
func (w *DAO) ObservedAt(ctx context.Context) (time.Time, error) {
	var now time.Time
	err := w.tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&now)
	if err != nil {
		return time.Time{}, pg.QueryError("read review clock", err)
	}
	return now.UTC(), nil
}
func (w *DAO) PullRequest(ctx context.Context, repoID, number int64) (*store.ReviewPR, error) {
	var p store.ReviewPR
	err := w.tx.QueryRow(ctx, `SELECT number,github_id,state FROM project_pull_requests WHERE project_id=$1 AND repository_id=$2 AND number=$3`, w.projectID, repoID, number).Scan(&p.Number, &p.GitHubID, &p.State)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, pg.QueryError("read review PR", err)
	}
	return &p, nil
}
func (w *DAO) Insert(ctx context.Context, userID string, repoID, githubPRID int64, workerID string, at time.Time) (bool, error) {
	tag, err := w.tx.Exec(ctx, `INSERT INTO project_pr_review_assignments (user_id,project_id,repository_id,github_pr_id,worker_id,assigned_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, userID, w.projectID, repoID, githubPRID, workerID, at)
	if err != nil {
		return false, pg.QueryError("insert review assignment", err)
	}
	return tag.RowsAffected() == 1, nil
}
