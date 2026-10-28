package server

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func (h *taskHandler) setStatus(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, id, logger, err := h.resource(request, principal)
	if err != nil {
		writeError(w, request, logger, "task", "set_status", err)
		return
	}
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		writeError(w, request, logger, "task", "set_status", invalidInput("task status does not accept query parameters"))
		return
	}
	fields, err := decodeObject(w, request, "version", "status", "claimId")
	if err != nil {
		writeError(w, request, logger, "task", "set_status", err)
		return
	}
	input := api.TaskStatusUpdateRequest{}
	input.Version, err = versionInput(fields)
	if err != nil {
		writeError(w, request, logger, "task", "set_status", err)
		return
	}
	input.Status, err = requiredString(fields, "status")
	if err != nil {
		writeError(w, request, logger, "task", "set_status", err)
		return
	}
	input.ClaimID, err = optionalString(fields, "claimId")
	if err != nil {
		writeError(w, request, logger, "task", "set_status", err)
		return
	}

	task, err := h.tasks.SetStatus(workerProtocolContext(request), principal, projectID, id, service.SetTaskStatus{Version: input.Version, Status: core.TaskStatus(input.Status), ClaimID: input.ClaimID})
	if err != nil {
		writeError(w, request, logger, "task", "set_status", err)
		return
	}
	outcome := "unchanged"
	if task.Version != input.Version {
		outcome = "changed"
	}
	logger.InfoContext(request.Context(), "task status set", "type", "resource", "component", "task", "phase", "set_status", "outcome", outcome, "request_id", RequestID(request.Context()))
	writeJSON(w, request, logger, http.StatusOK, taskResponse(task, request))
}
