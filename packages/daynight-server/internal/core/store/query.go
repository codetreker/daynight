package store

import (
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type Position struct {
	CreatedAt time.Time
	ID        string
}

type Page struct {
	After *Position
	Limit int
}

type ProjectPage struct {
	Items   []model.Project
	HasMore bool
}

type WorkerQuery struct {
	UserID   string
	WorkerID string
}

type TaskQuery struct {
	AssignedTo         model.TaskAssignmentFilter
	Page               Page
	Status             *model.TaskStatus
	Ready              *bool
	AllowAgents        *bool
	CompatiblePlatform *model.TaskPlatform
	Worker             *WorkerQuery
}

type TaskPage struct {
	Items   []model.Task
	HasMore bool
}
