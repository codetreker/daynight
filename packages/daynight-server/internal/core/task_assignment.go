package core

type TaskAssignmentMode string

const (
	TaskAssignmentAll        TaskAssignmentMode = ""
	TaskAssignmentUnassigned TaskAssignmentMode = "unassigned"
	TaskAssignmentUser       TaskAssignmentMode = "user"
)

type TaskAssignmentFilter struct {
	Mode   TaskAssignmentMode
	UserID string
}
