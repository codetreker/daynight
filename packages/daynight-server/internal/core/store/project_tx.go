package store

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
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
}

type DependencyReplacement struct {
	TaskID    string
	DependsOn []string
}
