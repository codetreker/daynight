package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

type SessionReader interface {
	CurrentTaskSessionSources(context.Context, string) ([]TaskSessionSource, error)
	TaskSessionSources(context.Context, string, []string) ([]TaskSessionSource, error)
	TaskSessionInspectionSource(context.Context, string, string, string) (TaskSessionSource, error)
}

type TaskSessionSource struct {
	ProjectID   string
	TaskID      string
	TaskVersion int64
	TaskStatus  model.TaskStatus
	Worker      *model.WorkerClaim
	Session     *TaskSessionStateSource
}

// Row identity and snapshot identity are independent evidence of the current
// execution. Keeping both lets the projection reject inconsistent bindings.
type TaskSessionStateSource struct {
	SessionID, ProjectID, TaskID, ClaimID                             string
	Backend, OwnerID, InitialInputState, ServerInstance, ArchiveState string
	ConnectionExpiry                                                  *time.Time
	TerminalFinalizationID                                            *string
	Fence                                                             sp.ControllerFence
	Identity                                                          sp.Identity
	Lifecycle                                                         string
	LastSeen, DrainUntil                                              *time.Time
}
