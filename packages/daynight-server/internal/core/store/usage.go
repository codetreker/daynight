package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type UsageStore interface {
	WriteUsage(context.Context, func(UsageScope) error) (Completion, error)
	ReadUsage(context.Context, func(UsageScope) error) error
}
type UsageScope interface {
	UsageDAO() UsageDAO
	SessionDAO() SessionDAO
}
type UsageSession struct {
	ID, Scope, Backend, OwnerID, ParentID, ConnectionParentID string
	ProjectID, TaskID, ClaimID, WorkerID, TestExecutionID     *string
	CreatedAt                                                 time.Time
	BotID                                                     *string
}
type UsageAuthorization struct {
	Access                           model.ProjectAccess
	TaskType                         model.TaskType
	AllowAgents, Paused, ClaimActive bool
	WorkerID                         *string
}
type UsageFilter struct {
	ProjectID, SessionID                 string
	TaskIDs                              []string
	Kind, StateID, Model, Provider, Role string
	AfterTime                            *time.Time
	AfterID                              string
	Limit                                int
}
type UsageRevision struct {
	Count, Hash string
	UpdatedAt   *time.Time
}
type UsageExecution struct {
	SessionID, Backend string
	TaskID             *string
	// State is a coverage-only projection, not a complete record for API responses.
	State                                *model.UsageRecord
	ParentValid, Allowed, Stopped, Known bool
	GapReasons                           []string
}
type UsageMember struct{ ID, Title string }

type UsageDAO interface {
	Now(context.Context) (time.Time, error)
	Session(context.Context, string) (UsageSession, error)
	LockTask(context.Context, UsageSession) (UsageAuthorization, error)
	ReadTask(context.Context, UsageSession) (UsageAuthorization, error)
	ProjectAccess(context.Context, string, string, bool) (model.ProjectAccess, error)
	ProjectPresent(context.Context, string) (bool, error)
	PermissionEpoch(context.Context, string, string) (string, error)
	ParentValid(context.Context, string, string, bool) (bool, error)
	State(context.Context, string) (model.UsageRecord, error)
	Generation(context.Context, string, string) (model.UsageRecord, error)
	Anchor(context.Context, string, string, string) (model.UsageRecord, error)
	Source(context.Context, model.UsageRecord, string) (model.UsageRecord, error)
	Insert(context.Context, model.UsageRecord) error
	Replace(context.Context, model.UsageRecord, string) error
	Guard(context.Context, model.UsageRecord) error
	Tasks(context.Context, string, []string) ([]UsageMember, error)
	Members(context.Context, string, string, string, int) ([]UsageMember, error)
	Metrics(context.Context, UsageFilter) (model.UsageSummary, error)
	TaskMetrics(context.Context, UsageFilter) (map[string]model.UsageSummary, error)
	Executions(context.Context, UsageFilter) ([]UsageExecution, error)
	Revision(context.Context, UsageFilter) (UsageRevision, error)
	Records(context.Context, UsageFilter) ([]model.UsageRecord, error)
}
