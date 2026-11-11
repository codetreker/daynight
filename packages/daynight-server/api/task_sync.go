package api

import (
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
	"time"
)

type TaskViewRecord = taskprotocol.SyncRecord

type TaskDependencyState struct {
	TaskVersion string   `json:"taskVersion"`
	BlockedBy   []string `json:"blockedBy"`
	Ready       bool     `json:"ready"`
}

type TaskSync struct {
	Mode             string                         `json:"mode"`
	Epoch            string                         `json:"epoch"`
	Project          Project                        `json:"project"`
	ActorAccess      ProjectAccess                  `json:"actorAccess"`
	ObservedAt       time.Time                      `json:"observedAt"`
	Tasks            []TaskViewRecord               `json:"tasks"`
	DependencyStates map[string]TaskDependencyState `json:"dependencyStates"`
	AssigneeVersions []TaskAssigneeVersion          `json:"assigneeVersions"`
	Sessions         map[string]string              `json:"sessions"`
}
