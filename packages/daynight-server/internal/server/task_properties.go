package server

import (
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
)

func propertyRoutes(mux *http.ServeMux, handler *taskHandler, auth *Authentication, logger *slog.Logger) {
	const schemaPath = "/api/v1/task-properties/schema"
	mux.HandleFunc("GET "+schemaPath, auth.Require(handler.propertySchema))
	mux.HandleFunc(schemaPath, auth.Require(resourceMethodNotAllowed(logger, "GET, HEAD")))
	const path = "/api/v1/projects/{projectId}/tasks/{taskId}/properties"
	mux.HandleFunc("GET "+path, auth.Require(handler.getProperties))
	mux.HandleFunc(path, auth.Require(resourceMethodNotAllowed(logger, "GET, HEAD")))
	mux.HandleFunc("PUT "+path+"/{name}", auth.Require(handler.setProperty))
	mux.HandleFunc("DELETE "+path+"/{name}", auth.Require(handler.removeProperty))
	mux.HandleFunc(path+"/{name}", auth.Require(resourceMethodNotAllowed(logger, "PUT, DELETE")))
}

func propertyResponse(task core.Task) api.PropertyResource {
	return api.PropertyResource{ProjectID: task.ProjectID, TaskID: task.ID, Version: task.Version, Properties: propertiesResponse(task.Properties)}
}

func propertyQuery(request *http.Request) error {
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		return invalidInput("property operations do not accept query parameters")
	}
	return nil
}

func (h *taskHandler) propertySchema(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	logger := h.logger.With("user_id", principal.UserID)
	if err := propertyQuery(request); err != nil {
		writeError(w, request, logger, "task_property", "schema", err)
		return
	}
	definitions := taskproperties.Definitions()
	response := api.TaskPropertySchema{Properties: make(map[string]api.TaskPropertyDefinition, len(definitions))}
	for name, definition := range definitions {
		response.Properties[name] = api.TaskPropertyDefinition{Description: definition.Description, ReadOnly: definition.ReadOnly, Schema: definition.Schema}
	}
	logger.InfoContext(request.Context(), "task property schema read", "type", "resource", "component", "task_property", "phase", "schema", "request_id", RequestID(request.Context()))
	writeJSON(w, request, logger, http.StatusOK, response)
}

func (h *taskHandler) getProperties(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	projectID, id, logger, err := h.resource(request, principal)
	if err != nil {
		writeError(w, request, logger, "task_property", "get", err)
		return
	}
	if err := propertyQuery(request); err != nil {
		writeError(w, request, logger, "task_property", "get", err)
		return
	}
	task, err := h.tasks.Get(request.Context(), principal, projectID, id)
	if err != nil {
		writeError(w, request, logger, "task_property", "get", err)
		return
	}
	logger.InfoContext(request.Context(), "task properties read", "type", "resource", "component", "task_property", "phase", "get", "request_id", RequestID(request.Context()))
	writeJSON(w, request, logger, http.StatusOK, propertyResponse(task))
}

func (h *taskHandler) setProperty(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	h.propertyMutation(w, request, principal, false)
}

func (h *taskHandler) removeProperty(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	h.propertyMutation(w, request, principal, true)
}

func (h *taskHandler) propertyMutation(w http.ResponseWriter, request *http.Request, principal core.Principal, remove bool) {
	phase := "set"
	allowed := []string{"version", "valueText"}
	if remove {
		phase = "remove"
		allowed = []string{"version"}
	}
	projectID, id, logger, err := h.resource(request, principal)
	if err != nil {
		writeError(w, request, logger, "task_property", phase, err)
		return
	}
	name := request.PathValue("name")
	if _, exists := taskproperties.Definitions()[name]; exists {
		logger = logger.With("property_name", name)
	}
	if err := propertyQuery(request); err != nil {
		writeError(w, request, logger, "task_property", phase, err)
		return
	}
	fields, err := decodeObject(w, request, allowed...)
	if err != nil {
		writeError(w, request, logger, "task_property", phase, err)
		return
	}
	version, err := versionInput(fields)
	if err != nil {
		writeError(w, request, logger, "task_property", phase, err)
		return
	}
	var task core.Task
	if remove {
		task, err = h.tasks.RemoveProperty(workerProtocolContext(request), principal, projectID, id, name, version)
	} else {
		var value string
		value, err = requiredString(fields, "valueText")
		if err == nil {
			task, err = h.tasks.SetProperty(workerProtocolContext(request), principal, projectID, id, name, value, version)
		}
	}
	if err != nil {
		writeError(w, request, logger, "task_property", phase, err)
		return
	}
	outcome := "unchanged"
	if task.Version != version {
		outcome = "changed"
	}
	logger.InfoContext(request.Context(), "task property operation applied", "type", "resource", "component", "task_property", "phase", phase,
		"outcome", outcome, "request_id", RequestID(request.Context()))
	writeJSON(w, request, logger, http.StatusOK, propertyResponse(task))
}
