package project

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// RegisterRepository reuses the unique visible repository match, or creates a
// Project when explicitly confirmed. Independent Projects remain permitted.
func (s *Projects) RegisterRepository(ctx context.Context, principal model.Principal, input core.CreateProject, confirm bool) (model.Project, bool, error) {
	if err := core.ValidateCreateFields(principal, input); err != nil {
		return model.Project{}, false, err
	}
	match, err := core.NewRepositoryMatch(input.RepoURL)
	if err != nil {
		return model.Project{}, false, err
	}
	request := core.ProjectListRequest{Page: model.PageRequest{Limit: 100}}
	err = read(ctx, s.store, func(dao store.ProjectReader) error {
		for {
			page, err := core.ReadList(ctx, dao, principal, request)
			if err != nil {
				return err
			}
			for _, candidate := range page.Items {
				if err := match.Add(candidate); err != nil {
					return err
				}
			}
			if !page.HasMore {
				return nil
			}
			finished, err := core.FinishList(principal, request, page)
			if err != nil {
				return err
			}
			request.Page.Cursor = finished.NextCursor
		}
	})
	if err != nil {
		return model.Project{}, false, err
	}
	selected, create, err := match.Select(confirm)
	if err != nil || !create {
		return selected, false, err
	}
	created, _, err := s.createValidated(ctx, principal, input)
	if err != nil {
		return model.Project{}, false, err
	}
	return created, true, nil
}
