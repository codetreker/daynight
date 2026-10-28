package server

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func (h *taskHandler) delete(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, id, logger, err := h.resource(request, principal)
	if err != nil {
		writeError(w, request, logger, "task", "delete", err)
		return
	}
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		writeError(w, request, logger, "task", "delete", invalidInput("task deletion does not accept query parameters"))
		return
	}
	fields, err := decodeObject(w, request, "version", "removeDepends")
	if err != nil {
		writeError(w, request, logger, "task", "delete", err)
		return
	}
	version, err := versionInput(fields)
	if err != nil {
		writeError(w, request, logger, "task", "delete", err)
		return
	}
	removeDepends, err := optionalBool(fields, "removeDepends")
	if err != nil {
		writeError(w, request, logger, "task", "delete", err)
		return
	}

	input := service.DeleteTask{Version: version, RemoveDepends: removeDepends != nil && *removeDepends}
	if err := h.tasks.Delete(workerProtocolContext(request), principal, projectID, id, input); err != nil {
		writeError(w, request, logger, "task", "delete", err)
		return
	}
	logger.InfoContext(request.Context(), "task deleted", "type", "resource", "component", "task", "phase", "delete", "request_id", RequestID(request.Context()))
	w.WriteHeader(http.StatusNoContent)
}
