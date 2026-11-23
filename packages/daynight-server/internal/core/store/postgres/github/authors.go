package github

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

// Authors derives the canonical login for each saved identity before searching.
// The window count is computed over the complete canonical set, not just the
// matching page, so an ambiguous login remains marked under any query.
func (r *reader) Authors(ctx context.Context, q store.GitHubAuthorQuery) (store.GitHubAuthorPage, error) {
	rows, err := r.tx.Query(ctx, `WITH canonical AS (
	 SELECT DISTINCT ON (author_id) author_id, author_login,
	        lower(author_login COLLATE "C") AS name_key
	 FROM project_pull_requests
	 WHERE project_id=$1`+repositoryFilter(q.RepositoryID, 6)+` AND author_id IS NOT NULL
	 ORDER BY author_id, observed_at DESC, revision DESC, number DESC
	), named AS (
	 SELECT author_id, author_login, name_key,
	        count(*) OVER (PARTITION BY name_key COLLATE "C") > 1 AS ambiguous
	 FROM canonical
	)
	SELECT author_id, author_login, name_key, ambiguous FROM named
	WHERE author_login IS NULL OR
	 (strpos(name_key, lower($2::text COLLATE "C")) > 0
	  AND ($3::text IS NULL OR (name_key COLLATE "C", author_id) > ($3::text COLLATE "C", $4::bigint)))
	ORDER BY name_key COLLATE "C" NULLS FIRST, author_id LIMIT $5`, q.ProjectID, q.Query, q.AnchorNameKey, q.AnchorAuthorID, q.Limit+1, q.RepositoryID)
	if err != nil {
		return store.GitHubAuthorPage{}, pg.QueryError("list github pull request authors", err)
	}
	defer rows.Close()
	page := store.GitHubAuthorPage{Items: []githubpr.Author{}}
	for rows.Next() {
		var author githubpr.Author
		if err := rows.Scan(&author.ID, &author.Login, &author.NameKey, &author.LoginAmbiguous); err != nil {
			return store.GitHubAuthorPage{}, pg.QueryError("list github pull request authors", err)
		}
		page.Items = append(page.Items, author)
	}
	if err := rows.Err(); err != nil {
		return store.GitHubAuthorPage{}, pg.QueryError("list github pull request authors", err)
	}
	page.HasMore = len(page.Items) > q.Limit
	if page.HasMore {
		page.Items = page.Items[:q.Limit]
	}
	return page, nil
}
