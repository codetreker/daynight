// Package github owns authorized reads of persisted GitHub facts.
package github

import (
	"context"
	"errors"
	"fmt"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type Reader struct {
	database  store.SnapshotReader
	available bool
}

func NewReader(database store.SnapshotReader, available bool) *Reader {
	return &Reader{database, available}
}

type Status struct {
	Connection       githubpr.Connection
	ServiceAvailable bool
}
type ListRequest struct {
	State, Query, Cursor string
	Limit                int
}
type Page struct {
	Connection                 githubpr.Connection
	Items                      []githubpr.PullRequestSummary
	Total                      int64
	Counts                     store.GitHubPRCounts
	NextCursor, PreviousCursor *string
}
type Detail struct {
	Connection  githubpr.Connection
	PullRequest githubpr.PullRequest
}

func invalid(message string) error { return &model.Fault{Code: "invalid_input", Message: message} }
func (r *Reader) snapshot(ctx context.Context, principal model.Principal, projectID string, work func(store.SnapshotScope, string) error) error {
	if err := model.RequirePrincipal(principal); err != nil {
		return err
	}
	id, err := model.CanonicalID(projectID)
	if err != nil {
		return err
	}
	var refusal *model.Fault
	err = r.database.ReadSnapshot(ctx, func(s store.SnapshotScope) error {
		if _, e := projectcore.RequireProjectRead(ctx, s.ProjectDAO(), principal, id); e != nil {
			if errors.As(e, &refusal) {
				return nil
			}
			return e
		}
		e := work(s, id)
		if errors.As(e, &refusal) {
			return nil
		}
		return e
	})
	if err != nil {
		return fmt.Errorf("read GitHub facts: %w", err)
	}
	if refusal != nil {
		return refusal
	}
	return nil
}
func (r *Reader) Get(ctx context.Context, principal model.Principal, projectID string) (Status, error) {
	result := Status{ServiceAvailable: r.available}
	err := r.snapshot(ctx, principal, projectID, func(s store.SnapshotScope, id string) error {
		var err error
		result.Connection, err = s.GitHubDAO().Connection(ctx, id)
		return err
	})
	if err != nil {
		return Status{}, err
	}
	return result, nil
}
func (r *Reader) Detail(ctx context.Context, principal model.Principal, projectID string, number int64) (Detail, error) {
	if number <= 0 {
		return Detail{}, invalid("Pull request number must be positive.")
	}
	var result Detail
	err := r.snapshot(ctx, principal, projectID, func(s store.SnapshotScope, id string) error {
		var err error
		dao := s.GitHubDAO()
		result.Connection, err = dao.Connection(ctx, id)
		if err != nil {
			return err
		}
		result.PullRequest, err = dao.PullRequest(ctx, id, number)
		if errors.Is(err, model.ErrNotFound) {
			return &model.Fault{Code: "not_found", Message: "Pull request was not found.", Cause: err}
		}
		return err
	})
	if err != nil {
		return Detail{}, err
	}
	return result, nil
}
func (r *Reader) List(ctx context.Context, principal model.Principal, projectID string, request ListRequest) (Page, error) {
	if request.State != "active" && request.State != "closed" && request.State != "merged" && request.State != "all" {
		return Page{}, invalid("State is invalid.")
	}
	if request.Limit < 1 || request.Limit > 100 {
		return Page{}, invalid("Limit must be between 1 and 100.")
	}
	if len(request.Query) > 1024 || !utf8.ValidString(request.Query) || containsNUL(request.Query) {
		return Page{}, invalid("Query is invalid.")
	}
	id, err := model.CanonicalID(projectID)
	if err != nil {
		return Page{}, err
	}
	query := store.GitHubPRQuery{ProjectID: id, State: request.State, Query: request.Query, Limit: request.Limit}
	var cursor *pageCursor
	if request.Cursor != "" {
		cursor, err = decodeCursor(request.Cursor, id, request)
		if err != nil {
			return Page{}, err
		}
		query.UpperNumber = &cursor.upper
		query.AnchorNumber = &cursor.anchor
		query.Previous = cursor.direction == "previous"
	}
	var result Page
	err = r.snapshot(ctx, principal, id, func(s store.SnapshotScope, id string) error {
		dao := s.GitHubDAO()
		var e error
		result.Connection, e = dao.Connection(ctx, id)
		if e != nil {
			return e
		}
		result.Counts, e = dao.PullRequestCounts(ctx, id)
		if e != nil {
			return e
		}
		page, e := dao.PullRequests(ctx, query)
		if e != nil {
			return e
		}
		result.Items, result.Total = page.Items, page.Total
		if page.UpperNumber == nil {
			return nil
		}
		next, previous := page.HasMore && !query.Previous, page.HasMore && query.Previous
		if cursor != nil {
			if query.Previous {
				next = true
			} else {
				previous = true
			}
		}
		if len(page.Items) > 0 {
			if next {
				result.NextCursor = encodeCursor(id, request, *page.UpperNumber, page.Items[len(page.Items)-1].Number, "next")
			}
			if previous {
				result.PreviousCursor = encodeCursor(id, request, *page.UpperNumber, page.Items[0].Number, "previous")
			}
		} else if cursor != nil && !query.Previous {
			// Include the former anchor when a changed collection empties this page.
			result.PreviousCursor = encodeCursor(id, request, *page.UpperNumber, cursor.anchor-1, "previous")
		} else if cursor != nil && query.Previous && cursor.anchor < int64(^uint64(0)>>1) {
			result.NextCursor = encodeCursor(id, request, *page.UpperNumber, cursor.anchor+1, "next")
		}
		return nil
	})
	if err != nil {
		return Page{}, err
	}
	if result.Items == nil {
		result.Items = []githubpr.PullRequestSummary{}
	}
	return result, nil
}
func containsNUL(s string) bool {
	for _, c := range s {
		if c == 0 {
			return true
		}
	}
	return false
}
