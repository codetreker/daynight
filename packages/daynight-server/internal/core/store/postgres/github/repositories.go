package github

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

func repositoryFilter(repositoryID *int64, parameter int) string {
	if repositoryID != nil {
		return fmt.Sprintf(" AND repository_id=$%d::bigint", parameter)
	}
	return fmt.Sprintf(" AND $%d::bigint IS NULL AND repository_id=(SELECT legacy_repository_id FROM project_github WHERE project_id=$1)", parameter)
}

func (r *reader) Repository(ctx context.Context, projectID string, repositoryID int64) (githubpr.Repository, error) {
	var source githubpr.Repository
	err := r.tx.QueryRow(ctx, `SELECT repository_id,full_name FROM project_github_repositories WHERE project_id=$1 AND repository_id=$2`, projectID, repositoryID).Scan(&source.RepositoryID, &source.FullName)
	if err != nil {
		return githubpr.Repository{}, pg.QueryError("read github repository source", err)
	}
	return source, nil
}

func (r *reader) Repositories(ctx context.Context, q store.GitHubRepositoriesQuery) ([]githubpr.Repository, error) {
	rows, err := r.tx.Query(ctx, `SELECT repository_id,full_name FROM project_github_repositories WHERE project_id=$1 AND ($2::bigint IS NULL OR repository_id>$2) ORDER BY repository_id LIMIT $3`, q.ProjectID, q.AfterRepositoryID, q.Limit+1)
	if err != nil {
		return nil, pg.QueryError("list github repository sources", err)
	}
	defer rows.Close()
	sources := []githubpr.Repository{}
	for rows.Next() {
		var source githubpr.Repository
		if err := rows.Scan(&source.RepositoryID, &source.FullName); err != nil {
			return nil, pg.QueryError("list github repository sources", err)
		}
		sources = append(sources, source)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("list github repository sources", err)
	}
	return sources, nil
}
