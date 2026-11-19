package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// ProjectRepositoryFacts are read together in a repository preview or write scope.
type ProjectRepositoryFacts struct {
	Project  model.Project
	Access   model.ProjectAccess
	Identity *string
	Version  int64
}

type ProjectRepositoryReadDAO interface {
	RepositoryFacts(context.Context, model.Principal) (ProjectRepositoryFacts, error)
}

type ProjectRepositoryWriteDAO interface {
	ProjectRepositoryReadDAO
	// The owner Team is exclusively locked before checking occupancy.
	RepositoryOccupiedByOther(context.Context, string, string) (bool, error)
	// SaveRepository changes a different address at the expected, non-exhausted version.
	SaveRepository(context.Context, string, string, int64) (int64, bool, error)
}
