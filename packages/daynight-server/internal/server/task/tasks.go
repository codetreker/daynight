package task

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"time"

	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"

	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"

	taskprops "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/properties"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type taskHandler struct {
	tasks        TaskService
	observations ObservationService
	sync         SyncOperation
	window       time.Duration
	logger       *slog.Logger
}

func TaskRoutes(mux *http.ServeMux, tasks TaskService, observations ObservationService, auth RouteAuthentication, logger *slog.Logger) {
	handler := &taskHandler{tasks: tasks, observations: observations, logger: logger}
	mux.HandleFunc("POST /api/v1/projects/{projectId}/tasks", auth.Require(handler.create))
	mux.HandleFunc("GET /api/v1/projects/{projectId}/task-work", auth.Require(handler.work))
	mux.HandleFunc("/api/v1/projects/{projectId}/task-work", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
	mux.HandleFunc("GET /api/v1/projects/{projectId}/tasks", auth.Require(handler.list))
	mux.HandleFunc("GET /api/v1/projects/{projectId}/tasks/{taskId}", auth.Require(handler.get))
	mux.HandleFunc("PATCH /api/v1/projects/{projectId}/tasks/{taskId}", auth.Require(handler.update))
	mux.HandleFunc("DELETE /api/v1/projects/{projectId}/tasks/{taskId}", auth.Require(handler.delete))
	mux.HandleFunc("PUT /api/v1/projects/{projectId}/tasks/{taskId}/status", auth.Require(handler.setStatus))
	mux.HandleFunc("/api/v1/projects/{projectId}/tasks/{taskId}/status", auth.Require(httpx.ResourceMethodNotAllowed(logger, "PUT")))
	workerRoutes(mux, handler, auth, logger)
	propertyRoutes(mux, handler, auth, logger)
	mux.HandleFunc("GET /api/v1/projects/{projectId}/task-assignees", auth.Require(handler.assignees))
	mux.HandleFunc("/api/v1/projects/{projectId}/task-assignees", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
	mux.HandleFunc("GET /api/v1/projects/{projectId}/task-graph", auth.Require(handler.graph))
	mux.HandleFunc("/api/v1/projects/{projectId}/task-graph", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
	mux.HandleFunc("/api/v1/projects/{projectId}/tasks", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, POST")))
	mux.HandleFunc("/api/v1/projects/{projectId}/tasks/{taskId}", auth.Require(func(w http.ResponseWriter, request *http.Request, principal model.Principal) {
		if request.PathValue("taskId") == "search" {
			httpx.ResourceMethodNotAllowed(logger, "POST")(w, request, principal)
			return
		}
		httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, PATCH, DELETE")(w, request, principal)
	}))
}

func taskResponse(task model.Task, request *http.Request) (api.Task, error) {
	return taskprotocol.RESTTask(task, extendedWorkerProtocol(request))
}

func propertiesResponse(properties model.TaskProperties) api.TaskProperties {
	return taskproperties.Clone(properties)
}

func propertyValues(properties api.TaskWritableProperties) model.TaskProperties {
	return taskproperties.Clone(model.TaskProperties(properties))
}

func optionalProperties(fields map[string]json.RawMessage) (*api.TaskPropertiesPatch, error) {
	raw, exists := fields["properties"]
	if !exists {
		return nil, nil
	}
	properties, err := taskprops.DecodePatch(raw)
	if err != nil {
		return nil, err
	}
	result := api.TaskPropertiesPatch(properties)
	return &result, nil
}

func (h *taskHandler) resource(request *http.Request, principal model.Principal) (string, string, *slog.Logger, error) {
	return TaskResource(request, principal, h.logger)
}

func TaskResource(request *http.Request, principal model.Principal, base *slog.Logger) (string, string, *slog.Logger, error) {
	logger := base.With("user_id", principal.UserID)
	projectID, err := model.CanonicalID(request.PathValue("projectId"))
	if err != nil {
		return "", "", logger, err
	}
	logger = logger.With("project_id", projectID)
	id := request.PathValue("taskId")
	if id != "" {
		id, err = model.CanonicalID(id)
		if err != nil {
			return "", "", logger, err
		}
		logger = logger.With("task_id", id)
	}
	return projectID, id, logger, nil
}

func createTaskInput(fields map[string]json.RawMessage) (api.CreateTaskRequest, error) {
	input := api.CreateTaskRequest{DependsOn: []string{}, Properties: api.TaskWritableProperties{}}
	var err error
	input.Title, err = httpx.RequiredString(fields, "title")
	if err != nil {
		return api.CreateTaskRequest{}, err
	}
	description, err := httpx.OptionalString(fields, "description")
	if err != nil {
		return api.CreateTaskRequest{}, err
	}
	if description != nil {
		input.Description = *description
	}
	dependencies, err := httpx.OptionalStrings(fields, "dependsOn")
	if err != nil {
		return api.CreateTaskRequest{}, err
	}
	if dependencies != nil {
		input.DependsOn = *dependencies
	}
	externalDependencies, err := httpx.OptionalStrings(fields, "externalDependsOn")
	if err != nil {
		return api.CreateTaskRequest{}, err
	}
	if externalDependencies != nil {
		input.ExternalDependsOn = *externalDependencies
	}
	properties, err := optionalProperties(fields)
	if err != nil {
		return api.CreateTaskRequest{}, err
	}
	if properties != nil {
		input.Properties = *properties
	}
	platform, err := optionalRequiredPlatform(fields)
	if err != nil {
		return api.CreateTaskRequest{}, err
	}
	if platform != nil {
		input.RequiredPlatform = *platform
	}
	assignedTo, err := optionalAssignedTo(fields)
	if err != nil {
		return api.CreateTaskRequest{}, err
	}
	if assignedTo != nil {
		input.AssignedTo = *assignedTo
	}
	return input, nil
}

func updateTaskInput(fields map[string]json.RawMessage) (api.UpdateTaskRequest, error) {
	var input api.UpdateTaskRequest
	var err error
	input.Version, err = httpx.VersionInput(fields)
	if err != nil {
		return api.UpdateTaskRequest{}, err
	}
	input.Title, err = httpx.OptionalString(fields, "title")
	if err != nil {
		return api.UpdateTaskRequest{}, err
	}
	input.Description, err = httpx.OptionalString(fields, "description")
	if err != nil {
		return api.UpdateTaskRequest{}, err
	}
	input.DependsOn, err = httpx.OptionalStrings(fields, "dependsOn")
	if err != nil {
		return api.UpdateTaskRequest{}, err
	}
	input.ExternalDependsOn, err = httpx.OptionalStrings(fields, "externalDependsOn")
	if err != nil {
		return api.UpdateTaskRequest{}, err
	}
	input.Properties, err = optionalProperties(fields)
	if err != nil {
		return api.UpdateTaskRequest{}, err
	}
	input.AllowAgents, err = httpx.OptionalBool(fields, "allowAgents")
	if err != nil {
		return api.UpdateTaskRequest{}, err
	}
	input.RequiredPlatform, err = optionalRequiredPlatform(fields)
	if err != nil {
		return api.UpdateTaskRequest{}, err
	}
	input.AssignedTo, err = optionalAssignedTo(fields)
	if err != nil {
		return api.UpdateTaskRequest{}, err
	}
	if input.Title == nil && input.Description == nil && input.DependsOn == nil && input.ExternalDependsOn == nil && input.AllowAgents == nil && input.RequiredPlatform == nil && input.AssignedTo == nil &&
		(input.Properties == nil || len(*input.Properties) == 0) {
		return api.UpdateTaskRequest{}, httpx.InvalidInput("at least one task field must be provided")
	}
	return input, nil
}

func taskListRequest(request *http.Request) (service.TaskListRequest, error) {
	values, err := httpx.QueryValues(request, "limit", "cursor", "status", "ready", "allowAgents", "compatiblePlatform", "platformSpecific", "workerId", "assignedTo", "include")
	if err != nil {
		return service.TaskListRequest{}, err
	}
	page, err := httpx.PageValues(values)
	if err != nil {
		return service.TaskListRequest{}, err
	}
	if _, err := sessionIncluded(request); err != nil {
		return service.TaskListRequest{}, err
	}
	result := service.TaskListRequest{PageRequest: page}
	if value, exists := values["assignedTo"]; exists {
		result.AssignedTo = &value[0]
	}
	if value, exists := values["status"]; exists {
		status := model.TaskStatus(value[0])
		result.Status = &status
	}
	if value, exists := values["ready"]; exists {
		if value[0] != "true" && value[0] != "false" {
			return service.TaskListRequest{}, httpx.InvalidInput("ready must be true or false")
		}
		ready := value[0] == "true"
		result.Ready = &ready
	}
	if value, exists := values["allowAgents"]; exists {
		if value[0] != "true" && value[0] != "false" {
			return service.TaskListRequest{}, httpx.InvalidInput("allowAgents must be true or false")
		}
		allowAgents := value[0] == "true"
		result.AllowAgents = &allowAgents
	}
	if value, exists := values["platformSpecific"]; exists {
		if value[0] != "true" && value[0] != "false" {
			return service.TaskListRequest{}, httpx.InvalidInput("platformSpecific must be true or false")
		}
		platformSpecific := value[0] == "true"
		result.PlatformSpecific = &platformSpecific
	}
	if value, exists := values["compatiblePlatform"]; exists {
		platform := model.TaskPlatform(value[0])
		result.CompatiblePlatform = &platform
	}
	if value, exists := values["workerId"]; exists {
		result.WorkerID = &value[0]
	}
	return result, nil
}

func (h *taskHandler) create(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, _, logger, err := h.resource(request, principal)
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "create", err)
		return
	}
	fields, err := httpx.DecodeObject(w, request, "title", "description", "dependsOn", "externalDependsOn", "properties", "requiredPlatform", "assignedTo")
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "create", err)
		return
	}
	input, err := createTaskInput(fields)
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "create", err)
		return
	}
	task, err := h.tasks.Create(request.Context(), principal, projectID, taskcore.CreateTask{
		AssignedTo: input.AssignedTo, RequiredPlatform: platformValue(input.RequiredPlatform), Title: input.Title, Description: input.Description, DependsOn: input.DependsOn, ExternalDependsOn: input.ExternalDependsOn, Properties: propertyValues(input.Properties),
	})
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "create", err)
		return
	}
	logger = logger.With("task_id", task.ID)
	logger.InfoContext(request.Context(), "task created", "type", "resource", "component", "task", "phase", "create", "request_id", httpx.RequestID(request.Context()))
	writeTaskMutation(w, request, logger, "task", http.StatusCreated, "/api/v1/projects/"+projectID+"/tasks/"+task.ID, task)
}

func (h *taskHandler) list(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, _, logger, err := h.resource(request, principal)
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "list", err)
		return
	}
	input, err := taskListRequest(request)
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "list", err)
		return
	}
	if included, _ := sessionIncluded(request); included {
		h.observedList(w, request, principal, projectID, input)
		return
	}
	page, err := h.listWorkerCompatibleTasks(request, principal, projectID, input)
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "list", err)
		return
	}
	response := api.TaskPage{Items: make([]api.Task, 0, len(page.Items)), NextCursor: page.NextCursor}
	for _, task := range page.Items {
		worker, err := taskproperties.Worker(task.Properties)
		if err != nil {
			httpx.WriteError(w, request, logger, "task", "list", err)
			return
		}
		if input.WorkerID != nil && !extendedWorkerProtocol(request) && !legacyWorkerCompatible(worker) {
			httpx.WriteError(w, request, logger, "task", "list", workerProtocolRequired())
			return
		}
		item, err := taskResponse(task, request)
		if err != nil {
			httpx.WriteError(w, request, logger, "task", "list", err)
			return
		}
		response.Items = append(response.Items, item)
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, response)
}

func (h *taskHandler) get(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, id, logger, err := h.resource(request, principal)
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "get", err)
		return
	}
	included, err := sessionIncluded(request)
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "get", err)
		return
	}
	if included {
		h.observedGet(w, request, principal, projectID, id)
		return
	}
	observation, err := h.tasks.Observe(request.Context(), principal, projectID, id)
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "get", err)
		return
	}
	logger.InfoContext(request.Context(), "task read", "type", "resource", "component", "task", "phase", "get", "request_id", httpx.RequestID(request.Context()))
	response, err := taskResponse(observation.Task, request)
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "response", err)
		return
	}
	w.Header().Set("Daynight-Task-Epoch", observation.Epoch)
	httpx.WriteJSON(w, request, logger, http.StatusOK, response)
}

func (h *taskHandler) update(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, id, logger, err := h.resource(request, principal)
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "update", err)
		return
	}
	fields, err := httpx.DecodeObject(w, request, "version", "title", "description", "dependsOn", "externalDependsOn", "properties", "allowAgents", "requiredPlatform", "assignedTo")
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "update", err)
		return
	}
	input, err := updateTaskInput(fields)
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "update", err)
		return
	}
	values := taskcore.UpdateTask{AssignedTo: input.AssignedTo, RequiredPlatform: platformPatch(input.RequiredPlatform), AllowAgents: input.AllowAgents, Version: input.Version, Title: input.Title, Description: input.Description, DependsOn: input.DependsOn, ExternalDependsOn: input.ExternalDependsOn}
	if input.Properties != nil {
		values.Properties = model.TaskPropertiesPatch(*input.Properties)
	}

	task, err := h.tasks.Update(workerProtocolContext(request), principal, projectID, id, values)
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "update", err)
		return
	}
	logger.InfoContext(request.Context(), "task updated", "type", "resource", "component", "task", "phase", "update", "request_id", httpx.RequestID(request.Context()))
	writeTaskMutation(w, request, logger, "task", http.StatusOK, "", task)
}

func committedResponseFailure(w http.ResponseWriter, request *http.Request, logger *slog.Logger, component string, err error) {
	logger = logger.With("tx_outcome", "committed", "write_outcome", "unknown", component+"_error_code", "write_outcome_unknown")
	failure := &model.Fault{Code: "write_outcome_unknown", Message: "The committed write response was not delivered.", Cause: err}
	httpx.LogFailure(logger, request.Context(), component, "response", failure)
	httpx.WriteJSON(w, request, logger, http.StatusServiceUnavailable, api.ErrorResponse{Error: api.Error{Code: failure.Code, Message: failure.Message, RequestID: httpx.RequestID(request.Context())}})
}

func writeTaskMutation(w http.ResponseWriter, request *http.Request, logger *slog.Logger, component string, status int, location string, task model.Task) {
	logger = logger.With("tx_outcome", "committed")
	response, err := taskResponse(task, request)
	if err != nil {
		committedResponseFailure(w, request, logger, component, err)
		return
	}
	if location != "" {
		w.Header().Set("Location", location)
	}
	httpx.WriteMutationJSON(w, request, logger, component, status, response)
}

func timestampResponse(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	utc := value.UTC()
	return &utc
}
