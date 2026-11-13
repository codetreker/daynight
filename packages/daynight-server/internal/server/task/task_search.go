package task

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type searchHandler struct {
	run              SearchOperation
	logger           *slog.Logger
	operationTimeout time.Duration
}

func TaskSearchRoutes(mux *http.ServeMux, search SearchOperation, auth RouteAuthentication, logger *slog.Logger) {
	h := &searchHandler{run: search, logger: logger, operationTimeout: 5 * time.Second}
	mux.HandleFunc("POST /api/v1/projects/{projectId}/tasks/search", auth.Require(h.search))
	for _, method := range []string{"GET", "PATCH", "DELETE"} {
		mux.HandleFunc(method+" /api/v1/projects/{projectId}/tasks/search", auth.Require(httpx.ResourceMethodNotAllowed(logger, "POST")))
	}
}
func searchInput(fields map[string]json.RawMessage) (tasksearch.Request, error) {
	input := tasksearch.Request{Limit: 50}
	var err error
	input.Query, err = httpx.RequiredString(fields, "query")
	if err != nil {
		return input, err
	}
	if raw, ok := fields["type"]; ok {
		var value string
		if json.Unmarshal(raw, &value) != nil || value == "" {
			return input, httpx.InvalidInput("type must be task or goal")
		}
		input.Type = model.TaskType(value)
	}
	if raw, ok := fields["parentId"]; ok {
		value := "none"
		if !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			if json.Unmarshal(raw, &value) != nil || value == "none" {
				return input, httpx.InvalidInput("parentId must be a UUID or null")
			}
		}
		input.Parent = &value
	}
	input.AssignedTo, err = httpx.OptionalString(fields, "assignedTo")
	if err != nil {
		return input, err
	}
	status, err := httpx.OptionalString(fields, "status")
	if err != nil {
		return input, err
	}
	if status != nil {
		value := model.TaskStatus(*status)
		input.Status = &value
	}
	input.Ready, err = httpx.OptionalBool(fields, "ready")
	if err != nil {
		return input, err
	}
	input.AllowAgents, err = httpx.OptionalBool(fields, "allowAgents")
	if err != nil {
		return input, err
	}
	platform, err := httpx.OptionalString(fields, "compatiblePlatform")
	if err != nil {
		return input, err
	}
	if platform != nil {
		value := model.TaskPlatform(*platform)
		input.CompatiblePlatform = &value
	}
	ids, err := httpx.OptionalStrings(fields, "tagIds")
	if err != nil {
		return input, err
	}
	if ids != nil {
		input.TagFilter.TagIDs = *ids
	}
	match, err := httpx.OptionalString(fields, "tagMatch")
	if err != nil {
		return input, err
	}
	if match != nil {
		input.TagFilter.TagMatch = *match
	}
	untagged, err := httpx.OptionalBool(fields, "untagged")
	if err != nil {
		return input, err
	}
	if untagged != nil {
		input.TagFilter.Untagged = *untagged
	}
	if raw, ok := fields["limit"]; ok {
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &input.Limit) != nil || input.Limit < 1 || input.Limit > 100 {
			return input, httpx.InvalidInput("limit must be an integer from 1 to 100")
		}
	}
	if raw, ok := fields["cursor"]; ok && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		input.Cursor, err = httpx.OptionalString(fields, "cursor")
		if err != nil {
			return input, err
		}
	}
	return input, nil
}
func searchResponse(page tasksearch.Page) api.TaskSearchPage {
	out := api.TaskSearchPage{ProjectID: page.ProjectID, Total: page.Total, Items: make([]api.TaskSearchItem, 0, len(page.Items)), NextCursor: page.NextCursor}
	for _, item := range page.Items {
		var c *api.TaskSearchContext
		if item.Context != nil {
			c = &api.TaskSearchContext{TaskID: item.Context.TaskID, Title: item.Context.Title}
		}
		out.Items = append(out.Items, api.TaskSearchItem{ID: item.ID, Type: string(item.Type), ParentID: item.ParentID, ProjectID: item.ProjectID, Title: item.Title, Status: string(item.Status), AssignedTo: item.AssignedTo, UpdatedAt: item.UpdatedAt, CancelledAt: timestampResponse(item.CancelledAt), Context: c, Match: api.TaskSearchMatch{Fields: item.Match.Fields, DescriptionSnippet: item.Match.DescriptionSnippet}, Tags: taskprotocol.RESTTags(item.Tags)})
	}
	return out
}
func (h *searchHandler) search(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, _, logger, err := TaskResource(request, principal, h.logger)
	if err != nil {
		httpx.WriteError(w, request, logger, "task_search", "input", err)
		return
	}
	fields, err := httpx.DecodeObject(w, request, "query", "assignedTo", "status", "ready", "allowAgents", "compatiblePlatform", "limit", "cursor", "type", "parentId", "tagIds", "tagMatch", "untagged")
	if err != nil {
		httpx.WriteError(w, request, logger, "task_search", "input", err)
		return
	}
	input, err := searchInput(fields)
	if err != nil {
		httpx.WriteError(w, request, logger, "task_search", "input", err)
		return
	}
	started := time.Now()
	operation, cancel := context.WithTimeout(request.Context(), h.operationTimeout)
	defer cancel()
	page, err := h.run(operation, principal, projectID, input)
	var response []byte
	if err == nil {
		response, err = json.Marshal(searchResponse(page))
	}
	if err == nil && operation.Err() != nil {
		err = operation.Err()
	}
	if err != nil {
		var transaction *store.TransactionError
		transactionFailed := errors.As(err, &transaction) && (transaction.Phase != "operation" || transaction.CleanupFailed || transaction.Outcome != store.TransactionNotCommitted)
		if !transactionFailed && request.Context().Err() == nil && errors.Is(operation.Err(), context.DeadlineExceeded) && errors.Is(err, context.DeadlineExceeded) {
			err = &model.Fault{Code: "search_timeout", Message: "Search timed out.", Cause: err}
		}
		httpx.WriteError(w, request, logger, "task_search", "search", err)
		return
	}
	if request.Context().Err() != nil {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(append(response, '\n')); err != nil {
		httpx.LogFailure(logger, request.Context(), "task_search", "response", err)
		return
	}
	logger.InfoContext(request.Context(), "task search completed", "type", "resource", "component", "task_search", "phase", "search", "request_id", httpx.RequestID(request.Context()), "duration", time.Since(started), "returned_count", len(page.Items), "total", page.Total, "node_count", page.NodeCount)
}
