package task

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

const taskRelationsHeader = "Daynight-Task-Relations"

func taskParentView(request *http.Request) bool {
	return request.Header.Get(taskRelationsHeader) == "task-parent-v1"
}

func validateTaskParentView(request *http.Request) error {
	values := request.Header.Values(taskRelationsHeader)
	if len(values) != 0 && (len(values) != 1 || values[0] != "task-parent-v1") {
		return httpx.InvalidInput("Daynight-Task-Relations must be task-parent-v1")
	}
	return nil
}
