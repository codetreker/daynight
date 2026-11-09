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
	var selected model.Project
	var found bool
	err = read(ctx, s.store, func(dao store.ProjectReader) error {
		var err error
		selected, found, err = core.FindRepository(ctx, dao, principal, match)
		return err
	})
	if err != nil {
		return model.Project{}, false, err
	}
	if found {
		return selected, false, nil
	}
	if err := core.RequireRepositoryCreationConfirmation(confirm); err != nil {
		return model.Project{}, false, err
	}
	created, _, err := s.createValidated(ctx, principal, input)
	if err != nil {
		return model.Project{}, false, err
	}
	return created, true, nil
}
