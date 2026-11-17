package github

import (
	"context"
	"fmt"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type AuthorsRequest struct {
	Query, Cursor string
	Limit         int
}
type AuthorsPage struct {
	Connection githubpr.Connection
	Items      []githubpr.Author
	NextCursor *string
}

// Authors reads the canonical directory within the same authorized snapshot as its revision.
func (r *Reader) Authors(ctx context.Context, principal model.Principal, projectID string, request AuthorsRequest) (AuthorsPage, error) {
	if request.Limit < 1 || request.Limit > 100 {
		return AuthorsPage{}, invalid("Limit must be between 1 and 100.")
	}
	if len(request.Query) > 1024 || !utf8.ValidString(request.Query) || containsNUL(request.Query) {
		return AuthorsPage{}, invalid("Query is invalid.")
	}
	id, err := model.CanonicalID(projectID)
	if err != nil {
		return AuthorsPage{}, err
	}
	query := store.GitHubAuthorQuery{ProjectID: id, Query: request.Query, Limit: request.Limit}
	var cursor *authorCursor
	if request.Cursor != "" {
		cursor, err = decodeAuthorCursor(request.Cursor, id, request)
		if err != nil {
			return AuthorsPage{}, err
		}
		query.AnchorNameKey, query.AnchorAuthorID = &cursor.nameKey, &cursor.authorID
	}
	var result AuthorsPage
	err = r.snapshot(ctx, principal, id, func(s store.SnapshotScope, id string) error {
		dao := s.GitHubDAO()
		var e error
		result.Connection, e = dao.Connection(ctx, id)
		if e != nil {
			return e
		}
		if cursor != nil && cursor.revision != result.Connection.Revision {
			return &model.Fault{Code: "resource_conflict", Message: "Author directory changed; start again."}
		}
		page, e := dao.Authors(ctx, query)
		if e != nil {
			return e
		}
		result.Items = page.Items
		if page.HasMore {
			if len(page.Items) == 0 {
				return fmt.Errorf("author directory returned an empty page with more results")
			}
			result.NextCursor, e = encodeAuthorCursor(id, request, result.Connection.Revision, page.Items[len(page.Items)-1])
			if e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		return AuthorsPage{}, err
	}
	if result.Items == nil {
		result.Items = []githubpr.Author{}
	}
	return result, nil
}
