package store

import "context"

// GoalDependencyDAO operates within a Project write transaction. LockTeam must
// precede all graph reads and writes; the Project lock is already held.
type GoalDependencyDAO interface {
	LockTeam(context.Context) error
	UnsatisfiedPrerequisites(context.Context, string) (bool, error)
	DoneSuccessors(context.Context, string) (bool, error)
	HasIncoming(context.Context, string) (bool, error)
	RemoveOutgoing(context.Context, string) error
}
