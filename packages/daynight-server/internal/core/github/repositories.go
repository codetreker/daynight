package github

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type RepositoriesRequest struct {
	Limit  int
	Cursor string
}

type RepositoriesPage struct {
	CurrentRepositoryID *int64
	Items               []githubpr.Repository
	NextCursor          *string
}

func selectedRepository(ctx context.Context, dao store.GitHubReadDAO, projectID string, repositoryID *int64) (*githubpr.Repository, error) {
	if repositoryID == nil {
		return nil, nil
	}
	repository, err := dao.Repository(ctx, projectID, *repositoryID)
	if errors.Is(err, model.ErrNotFound) {
		return nil, &model.Fault{Code: "not_found", Message: "Pull request repository was not found.", Cause: err}
	}
	if err != nil {
		return nil, err
	}
	return &repository, nil
}

func (r *Reader) Repositories(ctx context.Context, principal model.Principal, projectID string, request RepositoriesRequest) (RepositoriesPage, error) {
	return r.repositories(ctx, principal, projectID, request, nil)
}

func (r *Reader) RepositoriesAuthorized(ctx context.Context, authorization model.CredentialAuthorization, projectID string, request RepositoriesRequest) (RepositoriesPage, error) {
	if err := authorization.Validate(); err != nil {
		return RepositoriesPage{}, err
	}
	return r.repositories(ctx, authorization.Principal, projectID, request, func() error { return requireProjectScope(authorization) })
}

func (r *Reader) repositories(ctx context.Context, principal model.Principal, projectID string, request RepositoriesRequest, check func() error) (RepositoriesPage, error) {
	if request.Limit < 1 || request.Limit > 100 {
		return RepositoriesPage{}, invalid("Limit must be between 1 and 100.")
	}
	id, err := model.CanonicalID(projectID)
	if err != nil {
		return RepositoriesPage{}, err
	}
	query := store.GitHubRepositoriesQuery{ProjectID: id, Limit: request.Limit}
	if request.Cursor != "" {
		query.AfterRepositoryID, err = decodeRepositoryCursor(request.Cursor, id)
		if err != nil {
			return RepositoriesPage{}, err
		}
	}
	result := RepositoriesPage{Items: []githubpr.Repository{}}
	err = r.snapshot(ctx, principal, id, check, func(s store.SnapshotScope, id string) error {
		dao := s.GitHubDAO()
		connection, e := dao.Connection(ctx, id)
		if e != nil {
			return e
		}
		result.CurrentRepositoryID = connection.RepositoryID
		result.Items, e = dao.Repositories(ctx, query)
		if e != nil {
			return e
		}
		if len(result.Items) > request.Limit {
			result.Items = result.Items[:request.Limit]
			result.NextCursor = encodeRepositoryCursor(id, result.Items[len(result.Items)-1].RepositoryID)
		}
		return nil
	})
	if err != nil {
		return RepositoriesPage{}, err
	}
	if result.Items == nil {
		result.Items = []githubpr.Repository{}
	}
	return result, nil
}
