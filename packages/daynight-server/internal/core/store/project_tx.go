package store

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"time"
)

type TaskWrite struct {
	Type              model.TaskType
	ParentID          *string
	AssignedTo        *string
	RequiredPlatform  *model.TaskPlatform
	AllowAgents       bool
	Title             string
	Description       string
	Properties        model.TaskProperties
	Status            model.TaskStatus
	DependsOn         []string
	ExternalDependsOn []string
	GoalTiming        *GoalTiming
}

// GoalTiming carries the authoritative time and the complete Goal lifecycle times.
type GoalTiming struct {
	ObservedAt  time.Time
	StartedAt   *time.Time
	CompletedAt *time.Time
	CancelledAt *time.Time
}

type DependencyReplacement struct {
	TaskID    string
	DependsOn []string
}
