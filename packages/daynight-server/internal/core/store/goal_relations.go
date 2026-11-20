package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type GoalEndpoint struct{ ProjectID, GoalID string }
type GoalRelationTarget struct {
	ProjectID, ProjectName, GoalID, Title string
	Status                                model.TaskStatus
	Kind                                  string
}
type GoalRelationEdge struct {
	ID       string
	Endpoint GoalEndpoint
	Status   model.TaskStatus
	Target   *GoalRelationTarget
}
type GoalRelationSource struct {
	Type             model.TaskType
	Status           model.TaskStatus
	Deleted          bool
	CanRead, CanEdit bool
	TeamID           string
	Revision         int64
}
type GoalRelationAdmission struct {
	Source  GoalRelationSource
	Targets []GoalRelationCandidate
}
type GoalRelationCandidate struct {
	Endpoint  GoalEndpoint
	Available bool
	TeamID    string
	Status    model.TaskStatus
}

// GoalRelationReader shares its caller's read snapshot. Target omits hidden
// endpoint details; raw edge facts remain internal. Successor authorization
// precedes LIMIT.
type GoalRelationReader interface {
	Source(context.Context, string, string, string) (GoalRelationSource, error)
	Prerequisites(context.Context, string, string, string) ([]GoalRelationEdge, error)
	Successors(context.Context, string, string, string, string, int) ([]GoalRelationTarget, error)
}

// GoalRelationEditor is Project-bound. Admission reads source and candidate
// authorization, resource facts and ownership in one statement after LockTeam.
// No operation acquires a remote Project or Task row lock.
type GoalRelationEditor interface {
	LockTeam(context.Context) error
	Admission(context.Context, string, string, []GoalEndpoint) (GoalRelationAdmission, error)
	Edges(context.Context, string) ([]GoalRelationEdge, error)
	Reaches(context.Context, string, string, string, []string) (bool, error)
	Save(context.Context, string, int64, []GoalRelationEdge) error
}
