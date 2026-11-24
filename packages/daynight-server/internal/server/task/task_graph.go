package task

import (
	"net/http"
	"time"

	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
	projecthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/project"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func TaskGraphResponse(graph model.TaskGraph, relations ...bool) api.TaskGraph {
	enabled := len(relations) != 0 && relations[0]
	response := api.TaskGraph{
		Project:    projecthttp.ProjectResponse(graph.Project),
		ObservedAt: graph.ObservedAt.UTC(),
		Summary: api.TaskGraphSummary{
			Total: graph.Summary.Total, Proposed: graph.Summary.Proposed, Todo: graph.Summary.Todo, InProgress: graph.Summary.InProgress,
			Done: graph.Summary.Done, Cancelled: graph.Summary.Cancelled, Ready: graph.Summary.Ready, Blocked: graph.Summary.Blocked,
		},
		Tasks: make([]api.GraphTask, 0, len(graph.Tasks)),
	}
	for _, task := range graph.Tasks {
		parentID, parentTaskID := taskprotocol.ParentRelation(task.ParentID, task.ParentType, enabled)
		response.Tasks = append(response.Tasks, api.GraphTask{
			ID: task.ID, Type: string(task.Type), ParentID: parentID, ParentTaskID: parentTaskID, TitlePreview: task.TitlePreview, TitleTruncated: task.TitleTruncated, Status: string(task.Status),
			DependsOn: append([]string{}, task.DependsOn...), ExternalDependsOn: append([]string{}, task.ExternalDependsOn...), BlockedBy: append([]string{}, task.BlockedBy...), Ready: task.Ready, AllowAgents: task.AllowAgents, RequiredPlatform: platformResponse(task.RequiredPlatform), AssignedTo: task.AssignedTo,
			CreatedAt: task.CreatedAt.UTC(), UpdatedAt: task.UpdatedAt.UTC(),
			StartedAt: timestampResponse(task.StartedAt), CompletedAt: timestampResponse(task.CompletedAt), CancelledAt: timestampResponse(task.CancelledAt),
		})
	}
	return response
}

func (h *taskHandler) graph(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Add("Vary", taskRelationsHeader)
	start := time.Now()
	projectID, _, logger, err := h.resource(request, principal)
	if err != nil {
		httpx.WriteError(w, request, logger, "task_graph", "get", err)
		return
	}
	values, err := httpx.QueryValues(request, "taskId", "include")
	if err != nil {
		httpx.WriteError(w, request, logger, "task_graph", "get", err)
		return
	}
	taskID := values.Get("taskId")
	if taskID == "" {
		httpx.WriteError(w, request, logger, "task_graph", "get", httpx.InvalidInput("task graph requires taskId"))
		return
	}
	included, err := sessionIncluded(request)
	if err != nil {
		httpx.WriteError(w, request, logger, "task_graph", "get", err)
		return
	}
	if included {
		h.observedGraph(w, request, principal, projectID, taskID)
		return
	}
	graph, err := h.tasks.Graph(request.Context(), principal, projectID, taskID)
	if err != nil {

		httpx.WriteError(w, request, logger, "task_graph", "get", err)
		return
	}
	edgeCount := 0
	for _, task := range graph.Tasks {
		edgeCount += len(task.DependsOn)
	}
	logger.InfoContext(request.Context(), "task graph read", "type", "resource", "component", "task_graph", "phase", "get",
		"request_id", httpx.RequestID(request.Context()), "duration", time.Since(start), "node_count", len(graph.Tasks), "edge_count", edgeCount)
	response := TaskGraphResponse(graph, taskParentView(request))
	if h.taskOnly {
		w.Header().Set("Daynight-Projection", "task-only-v1")
		httpx.WriteJSON(w, request, logger, http.StatusOK, struct {
			api.TaskGraph
			Project taskOnlyProject `json:"project"`
		}{response, taskOnlyProject{ID: graph.Project.ID}})
		return
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, response)
}
