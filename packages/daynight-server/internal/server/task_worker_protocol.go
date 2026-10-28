package server

import (
	"context"
	"net/http"
	"slices"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func extendedWorkerProtocol(request *http.Request) bool {
	return request.Header.Get("Daynight-Worker-Protocol") == "2"
}

func legacyWorkerCompatible(worker *core.WorkerClaim) bool {
	return service.LegacyWorkerCompatible(worker)
}

func workerProtocolRequired() error {
	return &service.Fault{Code: "invalid_transition", Message: "This agent or control mode requires a compatible Daynight client. This request did not change the execution."}
}

func workerProtocolContext(request *http.Request) context.Context {
	if extendedWorkerProtocol(request) {
		return request.Context()
	}
	return service.WithLegacyWorkerProtocol(request.Context())
}

// Legacy workers identify discovery with these filters. Ordinary lists preserve
// every task, and inventory must report incompatible claims rather than hide them.
func (h *taskHandler) listWorkerCompatibleTasks(request *http.Request, principal core.Principal, projectID string, input service.TaskListRequest) (service.TaskPage, error) {
	legacyCandidates := !extendedWorkerProtocol(request) && input.WorkerID == nil && input.Ready != nil && *input.Ready && input.AllowAgents != nil && *input.AllowAgents && input.CompatiblePlatform != nil
	for {
		page, err := h.tasks.List(request.Context(), principal, projectID, input)
		if err != nil || !legacyCandidates {
			return page, err
		}
		page.Items = slices.DeleteFunc(page.Items, func(task core.Task) bool { return !legacyWorkerCompatible(task.Properties.Worker) })
		if len(page.Items) > 0 || page.NextCursor == nil {
			return page, nil
		}
		// Cursors track the original ordered scan, including entries the old worker
		// cannot execute. Never return an empty page with a continuation cursor.
		input.Cursor = page.NextCursor
	}
}
