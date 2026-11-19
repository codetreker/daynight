package store

import "context"

// ProjectGoalDependencyDAO operates under the Project root and owner Team graph
// locks. Removal advances each affected downstream Goal revision exactly once.
type ProjectGoalDependencyDAO interface {
	LockTeam(context.Context) error
	HasProjectEdges(context.Context) (bool, error)
	RemoveProjectEdges(context.Context) error
}
