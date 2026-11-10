package project

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// ResolveRepository returns the unique visible Project for an address without
// changing any Project. A later operation must check access again.
func (s *Projects) ResolveRepository(ctx context.Context, principal model.Principal, address string) (model.Project, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.Project{}, err
	}
	match, err := core.NewRepositoryMatch(address)
	if err != nil {
		return model.Project{}, err
	}
	var result model.Project
	var found bool
	err = read(ctx, s.store, func(dao store.ProjectReader) error {
		var err error
		result, found, err = s.findRepository(ctx, dao, principal, match)
		return err
	})
	if err != nil {
		return model.Project{}, err
	}
	if !found {
		return model.Project{}, core.ProjectNotFound(nil)
	}
	return result, nil
}
