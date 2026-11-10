package task

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/taskwork"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type ObservationService interface {
	ObserveGet(context.Context, model.Principal, string, string) (service.ObservedTask, error)
	ObserveList(context.Context, model.Principal, string, service.TaskListRequest) (service.ObservedTaskPage, error)
	ObserveGraph(context.Context, model.Principal, string, string) (service.ObservedGraph, error)
	WorkList(context.Context, model.Principal, string, taskcore.WorkRequest) (taskwork.Page, error)
}

// A distinct field type avoids promoting the persistent Task's MarshalJSON,
// which would otherwise hide the observation alongside the embedded Task.
type observedTaskFields api.Task
type observedTaskResponse struct {
	observedTaskFields
	Session sp.TaskSessionObservation `json:"session"`
}
type observedTaskPageResponse struct {
	Items      []observedTaskResponse `json:"items"`
	NextCursor *string                `json:"nextCursor"`
	ObservedAt time.Time              `json:"observedAt"`
	Partial    bool                   `json:"partial"`
}

func projectObservedTask(value service.ObservedTask, request *http.Request) (observedTaskResponse, error) {
	fields, err := taskResponse(value.Task, request)
	return observedTaskResponse{observedTaskFields: observedTaskFields(fields), Session: value.Session}, err
}
func sessionIncluded(request *http.Request) (bool, error) {
	values := request.URL.Query()["include"]
	if len(values) == 0 {
		return false, nil
	}
	if len(values) != 1 || values[0] != "session" {
		return false, httpx.InvalidInput("include must be session")
	}
	return true, nil
}
func (h *taskHandler) observedGet(w http.ResponseWriter, request *http.Request, principal model.Principal, projectID, taskID string) {
	logger := h.logger.With("project_id", projectID, "task_id", taskID, "user_id", principal.UserID)
	result, err := h.observations.ObserveGet(request.Context(), principal, projectID, taskID)
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "get", err)
		return
	}
	response, err := projectObservedTask(result, request)
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "response", err)
		return
	}
	w.Header().Set("Daynight-Task-Epoch", result.Epoch)
	httpx.WriteJSON(w, request, logger, http.StatusOK, response)
}
func (h *taskHandler) observedList(w http.ResponseWriter, request *http.Request, principal model.Principal, projectID string, input service.TaskListRequest) {
	logger := h.logger.With("project_id", projectID, "user_id", principal.UserID)
	page, err := h.observedWorkerCompatibleTasks(request, principal, projectID, input)
	if err != nil {
		httpx.WriteError(w, request, logger, "task", "list", err)
		return
	}
	response := observedTaskPageResponse{Items: make([]observedTaskResponse, 0, len(page.Items)), NextCursor: page.NextCursor, ObservedAt: page.ObservedAt, Partial: page.Partial}
	for _, item := range page.Items {
		value, err := projectObservedTask(item, request)
		if err != nil {
			httpx.WriteError(w, request, logger, "task", "response", err)
			return
		}
		response.Items = append(response.Items, value)
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, response)
}

func (h *taskHandler) observedWorkerCompatibleTasks(request *http.Request, principal model.Principal, projectID string, input service.TaskListRequest) (service.ObservedTaskPage, error) {
	legacy := !extendedWorkerProtocol(request)
	candidates := legacy && input.WorkerID == nil && input.Ready != nil && *input.Ready && input.AllowAgents != nil && *input.AllowAgents && input.CompatiblePlatform != nil
	for {
		page, err := h.observations.ObserveList(request.Context(), principal, projectID, input)
		if err != nil || !legacy {
			return page, err
		}
		items := make([]service.ObservedTask, 0, len(page.Items))
		for _, item := range page.Items {
			worker, err := taskproperties.Worker(item.Task.Properties)
			if err != nil {
				return service.ObservedTaskPage{}, err
			}
			if !legacyWorkerCompatible(worker) {
				if input.WorkerID != nil {
					return service.ObservedTaskPage{}, workerProtocolRequired()
				}
				if candidates {
					continue
				}
			}
			items = append(items, item)
		}
		page.Items = items
		if len(items) > 0 || page.NextCursor == nil || !candidates {
			return page, nil
		}
		input.Cursor = page.NextCursor
	}
}

type observedGraphNode struct {
	api.GraphTask
	Session  sp.TaskSessionObservation `json:"session"`
	Relation string                    `json:"relation"`
}
type observedGraphResponse struct {
	api.TaskGraph
	Tasks          []observedGraphNode  `json:"tasks"`
	SessionSummary taskwork.Aggregation `json:"sessionSummary"`
	Partial        bool                 `json:"partial"`
}

func (h *taskHandler) observedGraph(w http.ResponseWriter, request *http.Request, principal model.Principal, projectID, taskID string) {
	logger := h.logger.With("project_id", projectID, "task_id", taskID, "user_id", principal.UserID)
	result, err := h.observations.ObserveGraph(request.Context(), principal, projectID, taskID)
	if err != nil {
		httpx.WriteError(w, request, logger, "task_graph", "get", err)
		return
	}
	graph := TaskGraphResponse(result.Graph)
	response := observedGraphResponse{TaskGraph: graph, Tasks: make([]observedGraphNode, 0, len(graph.Tasks)), SessionSummary: result.Aggregation, Partial: result.Partial}
	for _, task := range graph.Tasks {
		response.Tasks = append(response.Tasks, observedGraphNode{GraphTask: task, Session: result.Sessions[task.ID], Relation: result.Relations[task.ID]})
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, response)
}
func (h *taskHandler) work(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, _, logger, err := h.resource(request, principal)
	if err != nil {
		httpx.WriteError(w, request, logger, "task_work", "list", err)
		return
	}
	values, err := httpx.QueryValues(request, "assignedTo", "limit", "cursor", "groupId", "targetsCursor")
	if err != nil {
		httpx.WriteError(w, request, logger, "task_work", "list", err)
		return
	}
	input := taskcore.WorkRequest{ResponseOverhead: 1}
	for key, target := range map[string]**string{"assignedTo": &input.AssignedTo, "cursor": &input.Cursor, "groupId": &input.GroupID, "targetsCursor": &input.TargetsCursor} {
		if raw, exists := values[key]; exists {
			value := raw[0]
			*target = &value
		}
	}
	if raw, exists := values["limit"]; exists {
		input.Limit, err = strconv.Atoi(raw[0])
		if err != nil || input.Limit < 1 || input.Limit > 50 {
			httpx.WriteError(w, request, logger, "task_work", "list", httpx.InvalidInput("limit must be between 1 and 50"))
			return
		}
	}
	result, err := h.observations.WorkList(request.Context(), principal, projectID, input)
	if err != nil {
		httpx.WriteError(w, request, logger, "task_work", "list", err)
		return
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, result)
}
