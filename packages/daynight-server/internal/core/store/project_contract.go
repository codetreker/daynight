package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

// ProjectWriter runs a write after locking the existing Project. Scope DAOs
// share its transaction and are valid only until the callback returns.
type ProjectWriter interface {
	WriteProject(context.Context, string, func(ProjectWriteScope) error) (Completion, error)
}

type ProjectCreationWriter interface {
	WriteProjectCreation(context.Context, string, func(ProjectCreationDAO) error) (Completion, error)
}

type ProjectCreationDAO interface {
	CreationPersonalTeam(context.Context, bool) (PersonalTeamFacts, error)
	LockCreationTeam(context.Context, string) (ProjectCreationTeam, error)
	CreationTeamMember(context.Context, string) (bool, error)
	InsertProject(context.Context, string, string, string, string) (model.Project, model.ProjectAccess, error)
}

type ProjectCreationTeam struct {
	ID             string
	PersonalUserID *string
}

type ProjectWriteScope interface {
	ProjectDAO() ProjectWriteDAO
	TaskDAO() TaskWriteDAO
	SessionDAO() ProjectSessionDAO
}

type ProjectWriteDAO interface {
	Project(context.Context) (model.Project, error)
	ProjectAccess(context.Context, model.Principal) (model.ProjectAccess, error)
	UpdateProjectSettings(context.Context, int32) (model.Project, error)
	DirectProjectMember(context.Context, string) (model.ProjectMember, error)
	SetMemberRole(context.Context, string, model.ProjectRole) (model.ProjectMember, error)
	RemoveMember(context.Context, string) error
	AddInvitedMember(context.Context, string) (model.ProjectMember, error)
	LockInvitation(context.Context, []byte) (model.ProjectInvitation, error)
	CreateInvitation(context.Context, model.ProjectInvitation) error
	RevokeInvitation(context.Context, string, time.Time) error
	ConsumeInvitation(context.Context, string, string, time.Time) error
	DirectGrant(context.Context, string) (model.ProjectGrant, error)
	CreateGrant(context.Context, string, model.ProjectRole) (model.ProjectGrant, error)
	LockTransferOwnership(context.Context) (model.ProjectOwnership, error)
	LockTransferTeams(context.Context, string, string) (TransferTeam, TransferTeam, error)
	MoveOwnership(context.Context, string) (model.ProjectOwnership, error)
}

type TaskWriteDAO interface {
	Task(context.Context, string) (model.Task, error)
	TasksByID(context.Context, []string) ([]model.Task, error)
	ActiveDependentIDs(context.Context, string) ([]string, error)
	Reachable(context.Context, string, string, DependencyReplacement) (bool, error)
	CreateTask(context.Context, string, TaskWrite) (model.Task, error)
	UpdateTask(context.Context, string, TaskWrite) (model.Task, error)
	ObservedAt(context.Context) (time.Time, error)
	DependentIDs(context.Context, string) ([]string, error)
	DeleteTask(context.Context, string, bool) error
	TaskHeader(context.Context, string) (model.TaskHeader, error)
	TaskSteps(context.Context, string) ([]model.TaskStep, error)
	InsertTaskStep(context.Context, string, model.TaskStep) error
	TouchTask(context.Context, string, time.Time) error
	UpdateTaskStep(context.Context, string, model.TaskStep) error
	MoveTaskStep(context.Context, string, string, int64, int64) error
	DeleteTaskStep(context.Context, string, string, int64, int64) error
}

type ProjectSessionDAO interface {
	MatchSessionStartup(context.Context, string, *model.WorkerClaim, sp.StartupReport) (bool, error)
}

var _ ProjectWriter = (*Store)(nil)
var _ ProjectCreationWriter = (*Store)(nil)
var _ ProjectWriteScope = (*ProjectTx)(nil)
var _ ProjectWriteDAO = (*ProjectTx)(nil)
var _ TaskWriteDAO = (*ProjectTx)(nil)
var _ ProjectSessionDAO = (*ProjectTx)(nil)
