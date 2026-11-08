package api

import (
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
	"time"
)

type TaskViewRecord = taskprotocol.SyncRecord

type TaskSync struct {
	Mode             string                `json:"mode"`
	Epoch            string                `json:"epoch"`
	Project          Project               `json:"project"`
	ActorAccess      ProjectAccess         `json:"actorAccess"`
	ObservedAt       time.Time             `json:"observedAt"`
	Tasks            []TaskViewRecord      `json:"tasks"`
	AssigneeVersions []TaskAssigneeVersion `json:"assigneeVersions"`
}
