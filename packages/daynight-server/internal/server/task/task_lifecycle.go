package task

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func (h *taskHandler) setStatus(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, id, logger, err := h.resource(request, principal)
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "set_status", err)
		return
	}
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		httpx.WriteError(w, request, logger, "task", "set_status", httpx.InvalidInput("task status does not accept query parameters"))
		return
	}
	fields, err := httpx.DecodeObject(w, request, "version", "status", "claimId")
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "set_status", err)
		return
	}
	input := api.TaskStatusUpdateRequest{}
	input.Version, err = httpx.VersionInput(fields)
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "set_status", err)
		return
	}
	input.Status, err = httpx.RequiredString(fields, "status")
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "set_status", err)
		return
	}
	input.ClaimID, err = httpx.OptionalString(fields, "claimId")
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "set_status", err)
		return
	}

	var metadata service.TaskWriteMetadata
	task, err := h.tasks.SetStatus(service.WithTaskWriteMetadata(workerProtocolContext(request), &metadata), principal, projectID, id, taskcore.SetTaskStatus{Version: input.Version, Status: model.TaskStatus(input.Status), ClaimID: input.ClaimID})
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "set_status", err)
		return
	}
	outcome := "unchanged"
	if task.Version != input.Version {
		outcome = "changed"
	}
	logger = taskWriteLogger(logger, metadata)
	logger.InfoContext(request.Context(), "task status set", "type", "resource", "component", "task", "phase", "set_status", "outcome", outcome, "request_id", httpx.RequestID(request.Context()))
	writeTaskMutation(w, request, logger, "task", http.StatusOK, "", task)
}
