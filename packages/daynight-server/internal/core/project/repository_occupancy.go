package project

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type repositoryOccupancy interface {
	RepositoryOccupied(context.Context, string, string) (bool, error)
}

// The caller holds the destination Team lock; a separate query sees the previous
// lock holder's commit under READ COMMITTED without locking other Projects.
func requireRepositoryAvailable(ctx context.Context, dao repositoryOccupancy, teamID, identity string) error {
	occupied, err := dao.RepositoryOccupied(ctx, teamID, identity)
	if err != nil {
		return err
	}
	if occupied {
		return &model.Fault{Code: "project_repository_conflict", Message: "The target Team already owns an active Project for this repository."}
	}
	return nil
}
