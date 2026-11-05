package task

import (
	"log/slog"
	"net/http"

	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"

	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
)

func propertyRoutes(mux *http.ServeMux, handler *taskHandler, auth *authhttp.Authentication, logger *slog.Logger) {
	const schemaPath = "/api/v1/task-properties/schema"
	mux.HandleFunc("GET "+schemaPath, auth.Require(handler.propertySchema))
	mux.HandleFunc(schemaPath, auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
	const path = "/api/v1/projects/{projectId}/tasks/{taskId}/properties"
	mux.HandleFunc("GET "+path, auth.Require(handler.getProperties))
	mux.HandleFunc(path, auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
	mux.HandleFunc("PUT "+path+"/{name}", auth.Require(handler.setProperty))
	mux.HandleFunc("DELETE "+path+"/{name}", auth.Require(handler.removeProperty))
	mux.HandleFunc(path+"/{name}", auth.Require(httpx.ResourceMethodNotAllowed(logger, "PUT, DELETE")))
}

func propertyResponse(task model.Task) api.PropertyResource {
	return api.PropertyResource{ProjectID: task.ProjectID, TaskID: task.ID, Version: task.Version, Properties: propertiesResponse(task.Properties)}
}

func propertyQuery(request *http.Request) error {
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		return httpx.InvalidInput("property operations do not accept query parameters")
	}
	return nil
}

func (h *taskHandler) propertySchema(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	logger := h.logger.With("user_id", principal.UserID)
	if err := propertyQuery(request); err != nil {
		httpx.WriteError(w, request, logger, "task_property", "schema", err)
		return
	}
	definitions := taskproperties.Definitions()
	response := api.TaskPropertySchema{Properties: make(map[string]api.TaskPropertyDefinition, len(definitions))}
	for name, definition := range definitions {
		response.Properties[name] = api.TaskPropertyDefinition{Description: definition.Description, ReadOnly: definition.ReadOnly, Schema: definition.Schema}
	}
	logger.InfoContext(request.Context(), "task property schema read", "type", "resource", "component", "task_property", "phase", "schema", "request_id", httpx.RequestID(request.Context()))
	httpx.WriteJSON(w, request, logger, http.StatusOK, response)
}

func (h *taskHandler) getProperties(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	projectID, id, logger, err := h.resource(request, principal)
	if err != nil {
		httpx.WriteError(w, request, logger, "task_property", "get", err)
		return
	}
	if err := propertyQuery(request); err != nil {
		httpx.WriteError(w, request, logger, "task_property", "get", err)
		return
	}
	task, err := h.tasks.Get(request.Context(), principal, projectID, id)
	if err != nil {
		httpx.WriteError(w, request, logger, "task_property", "get", err)
		return
	}
	logger.InfoContext(request.Context(), "task properties read", "type", "resource", "component", "task_property", "phase", "get", "request_id", httpx.RequestID(request.Context()))
	httpx.WriteJSON(w, request, logger, http.StatusOK, propertyResponse(task))
}

func (h *taskHandler) setProperty(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	h.propertyMutation(w, request, principal, false)
}

func (h *taskHandler) removeProperty(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	h.propertyMutation(w, request, principal, true)
}

func (h *taskHandler) propertyMutation(w http.ResponseWriter, request *http.Request, principal model.Principal, remove bool) {
	phase := "set"
	allowed := []string{"version", "valueText"}
	if remove {
		phase = "remove"
		allowed = []string{"version"}
	}
	projectID, id, logger, err := h.resource(request, principal)
	if err != nil {
		httpx.WriteError(w, request, logger, "task_property", phase, err)
		return
	}
	name := request.PathValue("name")
	if _, exists := taskproperties.Definitions()[name]; exists {
		logger = logger.With("property_name", name)
	}
	if err := propertyQuery(request); err != nil {
		httpx.WriteError(w, request, logger, "task_property", phase, err)
		return
	}
	fields, err := httpx.DecodeObject(w, request, allowed...)
	if err != nil {
		httpx.WriteError(w, request, logger, "task_property", phase, err)
		return
	}
	version, err := httpx.VersionInput(fields)
	if err != nil {
		httpx.WriteError(w, request, logger, "task_property", phase, err)
		return
	}
	var task model.Task
	if remove {
		task, err = h.tasks.RemoveProperty(workerProtocolContext(request), principal, projectID, id, name, version)
	} else {
		var value string
		value, err = httpx.RequiredString(fields, "valueText")
		if err == nil {
			task, err = h.tasks.SetProperty(workerProtocolContext(request), principal, projectID, id, name, value, version)
		}
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "task_property", phase, err)
		return
	}
	outcome := "unchanged"
	if task.Version != version {
		outcome = "changed"
	}
	logger.InfoContext(request.Context(), "task property operation applied", "type", "resource", "component", "task_property", "phase", phase,
		"outcome", outcome, "request_id", httpx.RequestID(request.Context()))
	httpx.WriteJSON(w, request, logger, http.StatusOK, propertyResponse(task))
}
