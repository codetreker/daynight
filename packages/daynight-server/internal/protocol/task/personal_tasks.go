package task

import (
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

// PersonalTaskPage is the account-wide lightweight Task inventory and its Session observations.
type PersonalTaskPage struct {
	ObservedAt        time.Time          `json:"observedAt"`
	InventoryRevision string             `json:"inventoryRevision"`
	TotalTaskCount    int64              `json:"totalTaskCount"`
	TotalProjectCount int64              `json:"totalProjectCount"`
	SessionPartial    bool               `json:"sessionPartial"`
	Items             []PersonalTaskItem `json:"items"`
	NextCursor        *string            `json:"nextCursor"`
}

type PersonalTaskItem struct {
	Project PersonalTaskProject       `json:"project"`
	Task    PersonalTask              `json:"task"`
	Session sp.TaskSessionObservation `json:"session"`
}

type PersonalTaskProject struct {
	ID                      string           `json:"id"`
	Name                    string           `json:"name"`
	OwnerTeam               PersonalTaskTeam `json:"ownerTeam"`
	ExecutionWarningMinutes int64            `json:"executionWarningMinutes"`
	MatchedTaskCount        int64            `json:"matchedTaskCount"`
}

type PersonalTaskTeam struct {
	ID   string  `json:"id"`
	Kind string  `json:"kind"`
	Name *string `json:"name"`
}

type PersonalTask struct {
	ID          string              `json:"id"`
	Version     string              `json:"version"`
	Title       string              `json:"title"`
	Status      string              `json:"status"`
	StartedAt   *time.Time          `json:"startedAt"`
	AllowAgents bool                `json:"allowAgents"`
	Paused      bool                `json:"paused"`
	Goal        *PersonalTaskGoal   `json:"goal"`
	Worker      *PersonalTaskWorker `json:"worker"`
}

type PersonalTaskWorker struct {
	WorkerID string              `json:"workerId"`
	Machine  PersonalTaskMachine `json:"machine"`
}

type PersonalTaskMachine struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type PersonalTaskGoal struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}
