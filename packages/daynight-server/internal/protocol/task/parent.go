package task

import "github.com/codetreker/daynight/packages/daynight-server/internal/core/model"

// ParentRelation preserves Goal navigation in the default representation. The
// outer pointer distinguishes an omitted extension from its explicit null value.
func ParentRelation(id *string, kind model.TaskType, enabled bool) (*string, **string) {
	goalID := id
	var taskID *string
	if kind == model.TaskTypeTask {
		goalID, taskID = nil, id
	}
	if enabled {
		return goalID, &taskID
	}
	return goalID, nil
}

func parentView(values []bool) bool { return len(values) != 0 && values[0] }
