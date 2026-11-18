package github

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

// PullRequestStatistics groups by the supplied segment labels in the caller's snapshot.
func (r *reader) PullRequestStatistics(ctx context.Context, q store.GitHubPRStatisticsQuery) (store.GitHubPRStatistics, error) {
	rows, err := r.tx.Query(ctx, `SELECT NULLIF(($3::integer[])[width_bucket(github_created_at, $2::timestamptz[])], -1) AS day,
	 count(*), count(*) FILTER (WHERE author_id=$4::bigint), bool_or(author_id IS NOT NULL)
	 FROM project_pull_requests WHERE project_id=$1 GROUP BY day`, q.ProjectID, q.Boundaries, q.DateIndices, q.AuthorID)
	if err != nil {
		return store.GitHubPRStatistics{}, pg.QueryError("aggregate github pull requests", err)
	}
	result := store.GitHubPRStatistics{Buckets: []store.GitHubPRStatisticsBucket{}}
	for rows.Next() {
		var bucket store.GitHubPRStatisticsBucket
		if err := rows.Scan(&bucket.DateIndex, &bucket.Total, &bucket.AuthorTotal, &bucket.HasAuthors); err != nil {
			rows.Close()
			return store.GitHubPRStatistics{}, pg.QueryError("aggregate github pull requests", err)
		}
		result.Buckets = append(result.Buckets, bucket)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return store.GitHubPRStatistics{}, pg.QueryError("aggregate github pull requests", err)
	}
	if q.AuthorID != nil {
		var author githubpr.Author
		err := r.tx.QueryRow(ctx, `SELECT author_id, author_login FROM project_pull_requests
		 WHERE project_id=$1 AND author_id=$2 ORDER BY observed_at DESC, revision DESC, number DESC LIMIT 1`, q.ProjectID, q.AuthorID).Scan(&author.ID, &author.Login)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return store.GitHubPRStatistics{}, pg.QueryError("read github pull request author", err)
		}
		if err == nil {
			result.Author = &author
		}
	}
	return result, nil
}
