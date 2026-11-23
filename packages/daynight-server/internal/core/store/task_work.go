package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type TaskWorkPosition struct {
	StartedAt time.Time `json:"startedAt"`
	GroupID   string    `json:"groupId"`
}

type TaskWorkTargetPosition struct {
	GroupID string `json:"groupId"`
	TaskID  string `json:"taskId"`
}

type TaskWorkQuery struct {
	AssignedTo string
	Limit      int
	After      *TaskWorkPosition
	GroupID    *string
}

type TaskWorkRoot struct {
	ID, TitlePreview string
	TitleTruncated   bool
}
type TaskWorkGroup struct {
	ID, DisplayTaskID, TitlePreview                       string
	TitleTruncated                                        bool
	MemberCount, MatchedCount, InProgressCount, RootCount int64
	Roots                                                 []TaskWorkRoot
	StartedAt                                             time.Time
}
type TaskWorkGroups struct {
	Items   []TaskWorkGroup
	HasMore bool
	Targets []TaskWorkTargetPosition
}
type TaskWorkTarget struct {
	GroupID string
	Task    model.Task
}
type TaskWorkTargets struct {
	Items []TaskWorkTarget
}

// The first snapshot selects groups and all their ordered ongoing target keys.
// Later snapshots read at most 200 exact keys without expanding the graph.
type TaskWorkReader interface {
	TaskWorkGroups(context.Context, string, TaskWorkQuery) (TaskWorkGroups, error)
	TaskWorkTargets(context.Context, string, []TaskWorkTargetPosition) (TaskWorkTargets, error)
}
