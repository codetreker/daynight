package store

import "context"

// ProjectGoalDependencyDAO operates under the Project root and owner Team graph
// locks. Removal advances each affected downstream Goal revision exactly once,
// and advances each live downstream Goal's Task watermark. When deleting the
// source Project, its Goals will not remain visible and are excluded from touch.
type ProjectGoalDependencyDAO interface {
	LockTeam(context.Context) error
	HasProjectEdges(context.Context) (bool, error)
	RemoveProjectEdges(context.Context, bool) error
}
