package task

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func (h *taskHandler) delete(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, id, logger, err := h.resource(request, principal)
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "delete", err)
		return
	}
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		httpx.WriteError(w, request, logger, "task", "delete", httpx.InvalidInput("task deletion does not accept query parameters"))
		return
	}
	fields, err := httpx.DecodeObject(w, request, "version", "removeDepends")
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "delete", err)
		return
	}
	version, err := httpx.VersionInput(fields)
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "delete", err)
		return
	}
	removeDepends, err := httpx.OptionalBool(fields, "removeDepends")
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "delete", err)
		return
	}

	input := taskcore.DeleteTask{Version: version, RemoveDepends: removeDepends != nil && *removeDepends}
	var metadata service.TaskWriteMetadata
	if err := h.tasks.Delete(service.WithTaskWriteMetadata(workerProtocolContext(request), &metadata), principal, projectID, id, input); err != nil {
		httpx.WriteError(w, request, logger, "task", "delete", err)
		return
	}
	logger = taskWriteLogger(logger, metadata)
	logger.InfoContext(request.Context(), "task deleted", "type", "resource", "component", "task", "phase", "delete", "request_id", httpx.RequestID(request.Context()))
	w.WriteHeader(http.StatusNoContent)
}
