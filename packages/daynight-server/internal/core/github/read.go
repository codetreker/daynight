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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
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
	AuthorID             *int64
	RepositoryID         *int64
}
type Page struct {
	Repository                 *githubpr.Repository
	Connection                 githubpr.Connection
	Items                      []githubpr.PullRequestSummary
	Total                      int64
	Counts                     store.GitHubPRCounts
	AuthorID                   *int64
	NextCursor, PreviousCursor *string
}
type Detail struct {
	Repository  *githubpr.Repository
	Connection  githubpr.Connection
	PullRequest githubpr.PullRequest
}

func invalid(message string) error { return &model.Fault{Code: "invalid_input", Message: message} }
func requireProjectScope(auth model.CredentialAuthorization) error {
	return scopeadmission.Require(auth, scopepolicy.ProjectRead)
}

// checkPullRequestScope establishes the targeted resource's existence inside
// the project snapshot before reporting a scope refusal or reading its data.
func checkPullRequestScope(ctx context.Context, s store.SnapshotScope, project string, number int64, repositoryID *int64, check func() error) error {
	if check == nil {
		return nil
	}
	visible, ok := s.GitHubDAO().(store.GitHubPullRequestVisibilityReader)
	if !ok {
		return fmt.Errorf("GitHub pull request visibility capability unavailable")
	}
	if repositoryID != nil {
		if err := visible.RequireRepositoryVisible(ctx, project, *repositoryID); err != nil {
			if errors.Is(err, model.ErrNotFound) {
				return &model.Fault{Code: "not_found", Message: "Pull request repository was not found.", Cause: err}
			}
			return err
		}
	}
	if err := visible.RequirePullRequestVisible(ctx, project, number, repositoryID); err != nil {
		if errors.Is(err, model.ErrNotFound) {
			return &model.Fault{Code: "not_found", Message: "Pull request was not found.", Cause: err}
		}
		return err
	}
	return check()
}

func checkRepositoryScope(ctx context.Context, s store.SnapshotScope, project string, repositoryID *int64, check func() error) error {
	if check == nil {
		return nil
	}
	if repositoryID != nil {
		visible, ok := s.GitHubDAO().(store.GitHubPullRequestVisibilityReader)
		if !ok {
			return fmt.Errorf("GitHub repository visibility capability unavailable")
		}
		if err := visible.RequireRepositoryVisible(ctx, project, *repositoryID); err != nil {
			if errors.Is(err, model.ErrNotFound) {
				return &model.Fault{Code: "not_found", Message: "Pull request repository was not found.", Cause: err}
			}
			return err
		}
	}
	return check()
}

func (r *Reader) snapshot(ctx context.Context, principal model.Principal, projectID string, check func() error, work func(store.SnapshotScope, string) error) error {
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
		if check != nil {
			if e := check(); e != nil {
				if errors.As(e, &refusal) {
					return nil
				}
				return e
			}
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
	err := r.snapshot(ctx, principal, projectID, nil, func(s store.SnapshotScope, id string) error {
		var err error
		result.Connection, err = s.GitHubDAO().Connection(ctx, id)
		return err
	})
	if err != nil {
		return Status{}, err
	}
	return result, nil
}
func (r *Reader) Detail(ctx context.Context, principal model.Principal, projectID string, number int64, repositoryID *int64) (Detail, error) {
	return r.detail(ctx, principal, projectID, number, repositoryID, nil)
}

func (r *Reader) DetailAuthorized(ctx context.Context, authorization model.CredentialAuthorization, projectID string, number int64, repositoryID *int64) (Detail, error) {
	if err := authorization.Validate(); err != nil {
		return Detail{}, err
	}
	return r.detail(ctx, authorization.Principal, projectID, number, repositoryID, func() error { return requireProjectScope(authorization) })
}

func (r *Reader) detail(ctx context.Context, principal model.Principal, projectID string, number int64, repositoryID *int64, check func() error) (Detail, error) {
	if repositoryID != nil && *repositoryID <= 0 {
		return Detail{}, invalid("Repository ID must be positive.")
	}
	if number <= 0 {
		return Detail{}, invalid("Pull request number must be positive.")
	}
	var result Detail
	err := r.snapshot(ctx, principal, projectID, nil, func(s store.SnapshotScope, id string) error {
		if err := checkPullRequestScope(ctx, s, id, number, repositoryID, check); err != nil {
			return err
		}
		var err error
		dao := s.GitHubDAO()
		result.Connection, err = dao.Connection(ctx, id)
		if err != nil {
			return err
		}
		result.Repository, err = selectedRepository(ctx, dao, id, repositoryID)
		if err != nil {
			return err
		}
		result.PullRequest, err = dao.PullRequest(ctx, id, number, repositoryID)
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
	return r.list(ctx, principal, projectID, request, nil)
}

func (r *Reader) ListAuthorized(ctx context.Context, authorization model.CredentialAuthorization, projectID string, request ListRequest) (Page, error) {
	if err := authorization.Validate(); err != nil {
		return Page{}, err
	}
	return r.list(ctx, authorization.Principal, projectID, request, func() error { return requireProjectScope(authorization) })
}

func (r *Reader) list(ctx context.Context, principal model.Principal, projectID string, request ListRequest, check func() error) (Page, error) {
	if request.State != "active" && request.State != "closed" && request.State != "merged" && request.State != "all" {
		return Page{}, invalid("State is invalid.")
	}
	if request.Limit < 1 || request.Limit > 100 {
		return Page{}, invalid("Limit must be between 1 and 100.")
	}
	if request.RepositoryID != nil && *request.RepositoryID <= 0 {
		return Page{}, invalid("Repository ID must be positive.")
	}
	if request.AuthorID != nil && *request.AuthorID <= 0 {
		return Page{}, invalid("Author ID must be positive.")
	}
	if len(request.Query) > 1024 || !utf8.ValidString(request.Query) || containsNUL(request.Query) {
		return Page{}, invalid("Query is invalid.")
	}
	id, err := model.CanonicalID(projectID)
	if err != nil {
		return Page{}, err
	}
	query := store.GitHubPRQuery{ProjectID: id, RepositoryID: request.RepositoryID, AuthorID: request.AuthorID, State: request.State, Query: request.Query, Limit: request.Limit}
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
	result := Page{AuthorID: request.AuthorID}
	err = r.snapshot(ctx, principal, id, nil, func(s store.SnapshotScope, id string) error {
		if err := checkRepositoryScope(ctx, s, id, request.RepositoryID, check); err != nil {
			return err
		}
		dao := s.GitHubDAO()
		var e error
		result.Connection, e = dao.Connection(ctx, id)
		if e != nil {
			return e
		}
		result.Repository, e = selectedRepository(ctx, dao, id, request.RepositoryID)
		if e != nil {
			return e
		}
		result.Counts, e = dao.PullRequestCounts(ctx, store.GitHubPRCountsQuery{ProjectID: id, RepositoryID: request.RepositoryID, AuthorID: request.AuthorID})
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
