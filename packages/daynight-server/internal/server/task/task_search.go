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
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type searchHandler struct {
	reader store.TaskSearchReader
	logger *slog.Logger
}

func TaskSearchRoutes(mux *http.ServeMux, reader store.TaskSearchReader, auth *authhttp.Authentication, logger *slog.Logger) {
	h := &searchHandler{reader: reader, logger: logger}
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
		out.Items = append(out.Items, api.TaskSearchItem{ID: item.ID, ProjectID: item.ProjectID, Title: item.Title, Status: string(item.Status), AssignedTo: item.AssignedTo, UpdatedAt: item.UpdatedAt, Context: c, Match: api.TaskSearchMatch{Fields: item.Match.Fields, DescriptionSnippet: item.Match.DescriptionSnippet}})
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
	fields, err := httpx.DecodeObject(w, request, "query", "assignedTo", "status", "ready", "allowAgents", "compatiblePlatform", "limit", "cursor")
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
	operation, cancel := context.WithTimeout(request.Context(), 5*time.Second)
	defer cancel()
	page, err := tasksearch.Search(operation, h.reader, principal, projectID, input)
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
