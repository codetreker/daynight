package project

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// RegisterRepository reuses a visible match in the resolved Team, or creates a
// Project when explicitly confirmed.
func (s *Projects) RegisterRepository(ctx context.Context, principal model.Principal, input core.CreateProject, confirm bool) (model.Project, bool, error) {
	if err := core.ValidateCreateFields(principal, input); err != nil {
		return model.Project{}, false, err
	}
	if input.TeamID == nil {
		return model.Project{}, false, &model.Fault{Code: "invalid_input", Message: "A target Team is required."}
	}
	teamID, err := model.CanonicalID(*input.TeamID)
	if err != nil {
		return model.Project{}, false, err
	}
	identity, err := core.RepositoryIdentity(input.RepoURL)
	if err != nil {
		return model.Project{}, false, err
	}
	var matches []model.Project
	err = read(ctx, s.store, func(dao store.ProjectReader) error {
		var err error
		matches, err = dao.FindVisibleRepositoryForCreation(ctx, principal, teamID, identity)
		return err
	})
	if err != nil {
		return model.Project{}, false, err
	}
	if len(matches) > 1 {
		return model.Project{}, false, &model.Fault{Code: "resource_conflict", Message: "Multiple accessible Projects match this repository."}
	}
	if len(matches) == 1 {
		return matches[0], false, nil
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
