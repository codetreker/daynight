package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
)

type taskHandler struct {
	tasks  *service.Tasks
	sync   *service.TaskSync
	window time.Duration
	logger *slog.Logger
}

func taskRoutes(mux *http.ServeMux, tasks *service.Tasks, auth *Authentication, logger *slog.Logger) {
	handler := &taskHandler{tasks: tasks, logger: logger}
	mux.HandleFunc("POST /api/v1/projects/{projectId}/tasks", auth.Require(handler.create))
	mux.HandleFunc("GET /api/v1/projects/{projectId}/tasks", auth.Require(handler.list))
	mux.HandleFunc("GET /api/v1/projects/{projectId}/tasks/{taskId}", auth.Require(handler.get))
	mux.HandleFunc("PATCH /api/v1/projects/{projectId}/tasks/{taskId}", auth.Require(handler.update))
	mux.HandleFunc("DELETE /api/v1/projects/{projectId}/tasks/{taskId}", auth.Require(handler.delete))
	mux.HandleFunc("PUT /api/v1/projects/{projectId}/tasks/{taskId}/status", auth.Require(handler.setStatus))
	mux.HandleFunc("/api/v1/projects/{projectId}/tasks/{taskId}/status", auth.Require(resourceMethodNotAllowed(logger, "PUT")))
	taskPropertyRoutes(mux, handler, auth, logger)
	workerRoutes(mux, handler, auth, logger)
	mux.HandleFunc("GET /api/v1/projects/{projectId}/task-graph", auth.Require(handler.graph))
	mux.HandleFunc("/api/v1/projects/{projectId}/task-graph", auth.Require(resourceMethodNotAllowed(logger, "GET, HEAD")))
	mux.HandleFunc("/api/v1/projects/{projectId}/tasks", auth.Require(resourceMethodNotAllowed(logger, "GET, HEAD, POST")))
	mux.HandleFunc("/api/v1/projects/{projectId}/tasks/{taskId}", auth.Require(resourceMethodNotAllowed(logger, "GET, HEAD, PATCH, DELETE")))
}

func taskResponse(task core.Task, request *http.Request) api.Task {
	result := api.Task{ID: task.ID, ProjectID: task.ProjectID, Title: task.Title, Description: task.Description,
		Properties: propertiesResponse(task.Properties), Status: string(task.Status), Version: task.Version, CreatedAt: task.CreatedAt.UTC(), UpdatedAt: task.UpdatedAt.UTC(),
		StartedAt: timestampResponse(task.StartedAt), CompletedAt: timestampResponse(task.CompletedAt),
		DependsOn: append([]string{}, task.DependsOn...), ExternalDependsOn: append([]string{}, task.ExternalDependsOn...), BlockedBy: append([]string{}, task.BlockedBy...), Ready: task.Ready, AllowAgents: task.AllowAgents, RequiredPlatform: platformResponse(task.RequiredPlatform)}
	if !extendedWorkerProtocol(request) {
		if !legacyWorkerCompatible(task.Properties.Worker) {
			result.Properties.Worker = nil
		} else if result.Properties.Worker != nil {
			result.Properties.Worker.AgentControlMode = ""
		}
	}
	return result
}

func propertiesResponse(properties core.TaskProperties) api.TaskProperties {
	result := api.TaskProperties{PullRequests: make([]api.PullRequestProperty, len(properties.PullRequests))}
	for index, item := range properties.PullRequests {
		result.PullRequests[index] = api.PullRequestProperty{URL: item.URL, Title: item.Title}
	}
	if worker := properties.Worker; worker != nil {
		result.Worker = &api.WorkerClaim{ClaimID: worker.ClaimID, State: string(worker.State), UserID: worker.UserID,
			WorkerID: worker.WorkerID, Machine: api.WorkerMachine{ID: worker.Machine.ID, Name: worker.Machine.Name},
			Platform: string(worker.Platform), Agent: string(worker.Agent), AgentControlMode: string(worker.AgentControlMode), WorktreeID: worker.WorktreeID,
			Phase: string(worker.Phase), Signaling: worker.Signaling, NativeSessionID: worker.NativeSessionID, ClaimedAt: worker.ClaimedAt.UTC()}
		if worker.Herdr != nil {
			result.Worker.Herdr = &api.WorkerHerdr{Session: worker.Herdr.Session, WorkspaceID: worker.Herdr.WorkspaceID, PaneID: worker.Herdr.PaneID}
		}
	}
	return result
}

func propertyValues(properties api.TaskWritableProperties) core.TaskProperties {
	result := core.TaskProperties{PullRequests: make([]core.PullRequestProperty, len(properties.PullRequests))}
	for index, item := range properties.PullRequests {
		result.PullRequests[index] = core.PullRequestProperty{URL: item.URL, Title: item.Title}
	}
	return result
}

func optionalProperties(fields map[string]json.RawMessage) (*api.TaskPropertiesPatch, error) {
	raw, exists := fields["properties"]
	if !exists {
		return nil, nil
	}
	properties, err := taskproperties.DecodePatch(raw)
	if err != nil {
		return nil, invalidInput(err.Error())
	}
	result := &api.TaskPropertiesPatch{}
	if properties.WorkerSignaling != nil {
		result.Worker = &api.WorkerSignalingPatch{Signaling: *properties.WorkerSignaling}
	}
	if properties.PullRequests != nil {
		values := propertiesResponse(core.TaskProperties{PullRequests: *properties.PullRequests})
		result.PullRequests = &values.PullRequests
	}
	return result, nil
}

func (h *taskHandler) resource(request *http.Request, principal core.Principal) (string, string, *slog.Logger, error) {
	logger := h.logger.With("user_id", principal.UserID)
	projectID, err := service.CanonicalID(request.PathValue("projectId"))
	if err != nil {
		return "", "", logger, err
	}
	logger = logger.With("project_id", projectID)
	id := request.PathValue("taskId")
	if id != "" {
		id, err = service.CanonicalID(id)
		if err != nil {
			return "", "", logger, err
		}
		logger = logger.With("task_id", id)
	}
	return projectID, id, logger, nil
}

func createTaskInput(fields map[string]json.RawMessage) (api.CreateTaskRequest, error) {
	input := api.CreateTaskRequest{DependsOn: []string{}, Properties: api.TaskWritableProperties{PullRequests: []api.PullRequestProperty{}}}
	var err error
	input.Title, err = requiredString(fields, "title")
	if err != nil {
		return api.CreateTaskRequest{}, err
	}
	description, err := optionalString(fields, "description")
	if err != nil {
		return api.CreateTaskRequest{}, err
	}
	if description != nil {
		input.Description = *description
	}
	dependencies, err := optionalStrings(fields, "dependsOn")
	if err != nil {
		return api.CreateTaskRequest{}, err
	}
	if dependencies != nil {
		input.DependsOn = *dependencies
	}
	externalDependencies, err := optionalStrings(fields, "externalDependsOn")
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
	if properties != nil && properties.Worker != nil {
		return api.CreateTaskRequest{}, invalidInput("Worker properties cannot be set when creating a task.")
	}
	if properties != nil && properties.PullRequests != nil {
		input.Properties.PullRequests = *properties.PullRequests
	}
	platform, err := optionalRequiredPlatform(fields)
	if err != nil {
		return api.CreateTaskRequest{}, err
	}
	if platform != nil {
		input.RequiredPlatform = *platform
	}
	return input, nil
}

func updateTaskInput(fields map[string]json.RawMessage) (api.UpdateTaskRequest, error) {
	var input api.UpdateTaskRequest
	var err error
	input.Version, err = versionInput(fields)
	if err != nil {
		return api.UpdateTaskRequest{}, err
	}
	input.Title, err = optionalString(fields, "title")
	if err != nil {
		return api.UpdateTaskRequest{}, err
	}
	input.Description, err = optionalString(fields, "description")
	if err != nil {
		return api.UpdateTaskRequest{}, err
	}
	input.DependsOn, err = optionalStrings(fields, "dependsOn")
	if err != nil {
		return api.UpdateTaskRequest{}, err
	}
	input.ExternalDependsOn, err = optionalStrings(fields, "externalDependsOn")
	if err != nil {
		return api.UpdateTaskRequest{}, err
	}
	input.Properties, err = optionalProperties(fields)
	if err != nil {
		return api.UpdateTaskRequest{}, err
	}
	input.AllowAgents, err = optionalBool(fields, "allowAgents")
	if err != nil {
		return api.UpdateTaskRequest{}, err
	}
	input.RequiredPlatform, err = optionalRequiredPlatform(fields)
	if err != nil {
		return api.UpdateTaskRequest{}, err
	}
	if input.Title == nil && input.Description == nil && input.DependsOn == nil && input.ExternalDependsOn == nil && input.AllowAgents == nil && input.RequiredPlatform == nil &&
		(input.Properties == nil || (input.Properties.PullRequests == nil && input.Properties.Worker == nil)) {
		return api.UpdateTaskRequest{}, invalidInput("at least one task field must be provided")
	}
	return input, nil
}

func taskListRequest(request *http.Request) (service.TaskListRequest, error) {
	values, err := queryValues(request, "limit", "cursor", "status", "ready", "allowAgents", "compatiblePlatform", "workerId")
	if err != nil {
		return service.TaskListRequest{}, err
	}
	page, err := pageValues(values)
	if err != nil {
		return service.TaskListRequest{}, err
	}
	result := service.TaskListRequest{PageRequest: page}
	if value, exists := values["status"]; exists {
		status := core.TaskStatus(value[0])
		result.Status = &status
	}
	if value, exists := values["ready"]; exists {
		if value[0] != "true" && value[0] != "false" {
			return service.TaskListRequest{}, invalidInput("ready must be true or false")
		}
		ready := value[0] == "true"
		result.Ready = &ready
	}
	if value, exists := values["allowAgents"]; exists {
		if value[0] != "true" && value[0] != "false" {
			return service.TaskListRequest{}, invalidInput("allowAgents must be true or false")
		}
		allowAgents := value[0] == "true"
		result.AllowAgents = &allowAgents
	}
	if value, exists := values["compatiblePlatform"]; exists {
		platform := core.TaskPlatform(value[0])
		result.CompatiblePlatform = &platform
	}
	if value, exists := values["workerId"]; exists {
		result.WorkerID = &value[0]
	}
	return result, nil
}

func (h *taskHandler) create(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, _, logger, err := h.resource(request, principal)
	if err != nil {
		writeError(w, request, logger, "task", "create", err)
		return
	}
	fields, err := decodeObject(w, request, "title", "description", "dependsOn", "externalDependsOn", "properties", "requiredPlatform")
	if err != nil {
		writeError(w, request, logger, "task", "create", err)
		return
	}
	input, err := createTaskInput(fields)
	if err != nil {
		writeError(w, request, logger, "task", "create", err)
		return
	}
	task, err := h.tasks.Create(request.Context(), principal, projectID, service.CreateTask{
		RequiredPlatform: platformValue(input.RequiredPlatform), Title: input.Title, Description: input.Description, DependsOn: input.DependsOn, ExternalDependsOn: input.ExternalDependsOn, Properties: propertyValues(input.Properties),
	})
	if err != nil {
		writeError(w, request, logger, "task", "create", err)
		return
	}
	logger = logger.With("task_id", task.ID)
	logger.InfoContext(request.Context(), "task created", "type", "resource", "component", "task", "phase", "create", "request_id", RequestID(request.Context()))
	writeCreated(w, request, logger, "/api/v1/projects/"+projectID+"/tasks/"+task.ID, taskResponse(task, request))
}

func (h *taskHandler) list(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, _, logger, err := h.resource(request, principal)
	if err != nil {
		writeError(w, request, logger, "task", "list", err)
		return
	}
	input, err := taskListRequest(request)
	if err != nil {
		writeError(w, request, logger, "task", "list", err)
		return
	}
	page, err := h.listWorkerCompatibleTasks(request, principal, projectID, input)
	if err != nil {
		writeError(w, request, logger, "task", "list", err)
		return
	}
	response := api.TaskPage{Items: make([]api.Task, 0, len(page.Items)), NextCursor: page.NextCursor}
	for _, task := range page.Items {
		if input.WorkerID != nil && !extendedWorkerProtocol(request) && !legacyWorkerCompatible(task.Properties.Worker) {
			writeError(w, request, logger, "task", "list", workerProtocolRequired())
			return
		}
		response.Items = append(response.Items, taskResponse(task, request))
	}
	writeJSON(w, request, logger, http.StatusOK, response)
}

func (h *taskHandler) get(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, id, logger, err := h.resource(request, principal)
	if err != nil {
		writeError(w, request, logger, "task", "get", err)
		return
	}
	task, err := h.tasks.Get(request.Context(), principal, projectID, id)
	if err != nil {
		writeError(w, request, logger, "task", "get", err)
		return
	}
	logger.InfoContext(request.Context(), "task read", "type", "resource", "component", "task", "phase", "get", "request_id", RequestID(request.Context()))
	writeJSON(w, request, logger, http.StatusOK, taskResponse(task, request))
}

func (h *taskHandler) update(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, id, logger, err := h.resource(request, principal)
	if err != nil {
		writeError(w, request, logger, "task", "update", err)
		return
	}
	fields, err := decodeObject(w, request, "version", "title", "description", "dependsOn", "externalDependsOn", "properties", "allowAgents", "requiredPlatform")
	if err != nil {
		writeError(w, request, logger, "task", "update", err)
		return
	}
	input, err := updateTaskInput(fields)
	if err != nil {
		writeError(w, request, logger, "task", "update", err)
		return
	}
	values := service.UpdateTask{RequiredPlatform: platformPatch(input.RequiredPlatform), AllowAgents: input.AllowAgents, Version: input.Version, Title: input.Title, Description: input.Description, DependsOn: input.DependsOn, ExternalDependsOn: input.ExternalDependsOn}
	if input.Properties != nil && input.Properties.Worker != nil {
		values.Properties.WorkerSignaling = &input.Properties.Worker.Signaling
	}
	if input.Properties != nil && input.Properties.PullRequests != nil {
		properties := propertyValues(api.TaskWritableProperties{PullRequests: *input.Properties.PullRequests})
		values.Properties.PullRequests = &properties.PullRequests
	}

	task, err := h.tasks.Update(workerProtocolContext(request), principal, projectID, id, values)
	if err != nil {
		writeError(w, request, logger, "task", "update", err)
		return
	}
	logger.InfoContext(request.Context(), "task updated", "type", "resource", "component", "task", "phase", "update", "request_id", RequestID(request.Context()))
	writeJSON(w, request, logger, http.StatusOK, taskResponse(task, request))
}

func timestampResponse(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	utc := value.UTC()
	return &utc
}
