package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// ProjectDeletionReader keeps authorization, counts and blocker observations in one snapshot.
type ProjectDeletionReader interface {
	ReadProjectDeletion(context.Context, string, func(ProjectDeletionSnapshot) error) error
}

type ProjectDeletionSnapshot interface {
	ProjectDAO() ProjectReader
	ObservedAt(context.Context) (time.Time, error)
	Summary(context.Context) (ProjectDeletionSummary, error)
	VisitTaskWorkers(context.Context, func(ProjectDeletionWorker) error) error
}

type ProjectDeletionSummary struct {
	TaskCount           int64
	UnfinishedTaskCount int64
	AttachmentCount     int64
}

type ProjectDeletionWorker struct {
	TaskID     string
	Title      string
	Worker     *model.WorkerClaim
	Paused     bool
	LastSeenAt *time.Time
}

// ProjectDeletionWriter holds the Project and every historical Task lock through completion.
// Scope DAOs are only valid during the callback.
type ProjectDeletionWriter interface {
	WriteProjectDeletion(context.Context, string, func(ProjectDeletionScope) error) (Completion, error)
}

type ProjectDeletionScope interface {
	ProjectDAO() ProjectDeletionDAO
	SessionDAO() ProjectSessionRetirementDAO
	WebhookEligibilityDAO() WebhookEligibilityDAO
}

type ProjectDeletionDAO interface {
	Authorization(context.Context, model.Principal) (model.ProjectAccess, error)
	VisitTaskWorkers(context.Context, func(ProjectDeletionWorker) error) error
	MarkDeleted(context.Context) (bool, error)
}
