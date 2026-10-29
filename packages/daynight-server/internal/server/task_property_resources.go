package server

import (
	"log/slog"
	"net/http"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
)

func taskPropertyRoutes(mux *http.ServeMux, handler *taskHandler, auth *Authentication, logger *slog.Logger) {
	path := "/api/v1/projects/{projectId}/tasks/{taskId}/properties"
	mux.HandleFunc("GET "+path, auth.Require(handler.getProperties))
	mux.HandleFunc("PUT "+path, auth.Require(handler.mutateProperty))
	mux.HandleFunc("DELETE "+path, auth.Require(handler.mutateProperty))
	mux.HandleFunc(path, auth.Require(resourceMethodNotAllowed(logger, "GET, HEAD, PUT, DELETE")))
}

func taskPropertiesResponse(task core.Task) api.TaskPropertiesResource {
	return api.TaskPropertiesResource{Version: strconv.FormatInt(task.Version, 10), Properties: propertiesResponse(task.Properties)}
}

func (h *taskHandler) getProperties(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, id, logger, err := h.resource(request, principal)
	if err != nil {
		writeError(w, request, logger, "task_properties", "get", err)
		return
	}
	task, err := h.tasks.Get(request.Context(), principal, projectID, id)
	if err != nil {
		writeError(w, request, logger, "task_properties", "get", err)
		return
	}
	logger.InfoContext(request.Context(), "task properties read", "type", "resource", "component", "task_properties", "phase", "get", "request_id", RequestID(request.Context()))
	writeJSON(w, request, logger, http.StatusOK, taskPropertiesResponse(task))
}

func (h *taskHandler) mutateProperty(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	phase := "remove"
	allowed := []string{"version", "property"}
	if request.Method == http.MethodPut {
		phase = "set"
		allowed = append(allowed, "value")
	}
	projectID, id, logger, err := h.resource(request, principal)
	if err != nil {
		writeError(w, request, logger, "task_properties", phase, err)
		return
	}
	fields, err := decodeObject(w, request, allowed...)
	if err != nil {
		writeError(w, request, logger, "task_properties", phase, err)
		return
	}
	version, err := versionInput(fields)
	if err != nil {
		writeError(w, request, logger, "task_properties", phase, err)
		return
	}
	property, err := requiredString(fields, "property")
	if err != nil {
		writeError(w, request, logger, "task_properties", phase, err)
		return
	}
	var properties core.TaskPropertiesPatch
	if request.Method == http.MethodPut {
		value, valueErr := requiredString(fields, "value")
		if valueErr != nil {
			writeError(w, request, logger, "task_properties", phase, valueErr)
			return
		}
		properties, err = taskproperties.DecodePropertyArgument(property, value)
	} else {
		properties, err = taskproperties.DecodePropertyRemoval(property)
	}
	if err != nil {
		writeError(w, request, logger, "task_properties", phase, invalidInput(err.Error()))
		return
	}
	task, err := h.tasks.Update(workerProtocolContext(request), principal, projectID, id, service.UpdateTask{Version: version, Properties: properties})
	if err != nil {
		writeError(w, request, logger, "task_properties", phase, err)
		return
	}
	logger.InfoContext(request.Context(), "task property updated", "type", "resource", "component", "task_properties", "phase", phase, "request_id", RequestID(request.Context()))
	writeJSON(w, request, logger, http.StatusOK, taskPropertiesResponse(task))
}
