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

type TaskSyncObservation struct {
	TaskVersion    string     `json:"taskVersion"`
	State          string     `json:"state"`
	ObservedAt     *time.Time `json:"observedAt"`
	FreshUntil     *time.Time `json:"freshUntil"`
	NeedsAttention *bool      `json:"needsAttention"`
	CanOpen        bool       `json:"canOpen"`
}

type TaskSync struct {
	Mode              string                         `json:"mode"`
	Epoch             string                         `json:"epoch"`
	Project           Project                        `json:"project"`
	ActorAccess       ProjectAccess                  `json:"actorAccess"`
	ObservedAt        time.Time                      `json:"observedAt"`
	Tasks             []TaskViewRecord               `json:"tasks"`
	DependencyStates  map[string]TaskDependencyState `json:"dependencyStates"`
	AssigneeVersions  []TaskAssigneeVersion          `json:"assigneeVersions"`
	Sessions          map[string]string              `json:"sessions"`
	TaskObservations  map[string]TaskSyncObservation `json:"taskObservations"`
	SessionPartial    bool                           `json:"sessionPartial"`
	ResponseTaskAt    time.Time                      `json:"responseTaskAt"`
	ResponseSessionAt time.Time                      `json:"responseSessionAt"`
}
