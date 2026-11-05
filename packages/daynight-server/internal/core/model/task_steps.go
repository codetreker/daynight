package model

import "time"

type TaskStepStatus string

const (
	TaskStepTodo       TaskStepStatus = "todo"
	TaskStepInProgress TaskStepStatus = "in_progress"
	TaskStepDone       TaskStepStatus = "done"
	TaskStepSkipped    TaskStepStatus = "skipped"
)

func (status TaskStepStatus) Valid() bool {
	return status == TaskStepTodo || status == TaskStepInProgress || status == TaskStepDone || status == TaskStepSkipped
}

// TaskHeader permits child resources to check identity, deletion and version
// without hydrating unrelated task properties, dependencies or execution state.
type TaskHeader struct {
	ProjectID string
	ID        string
	Version   int64
	DeletedAt *time.Time
}

type TaskStep struct {
	ID          string
	Position    int64
	Title       string
	Description string
	Status      TaskStepStatus
	CreatedAt   time.Time
	UpdatedAt   time.Time
}
