package task

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	protocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type PersonalTasksOperation func(context.Context, model.Principal, int, *string) (service.PersonalTaskPage, error)

func PersonalTaskRoutes(mux *http.ServeMux, run PersonalTasksOperation, auth RouteAuthentication, logger *slog.Logger) {
	h := personalTaskHandler{run: run, logger: logger}
	mux.HandleFunc("GET /api/v1/me/in-progress-tasks", auth.Require(h.list))
	mux.HandleFunc("/api/v1/me/in-progress-tasks", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
}

type personalTaskHandler struct {
	run    PersonalTasksOperation
	logger *slog.Logger
}

func personalTaskResponse(page service.PersonalTaskPage) protocol.PersonalTaskPage {
	out := protocol.PersonalTaskPage{ObservedAt: page.ObservedAt, InventoryRevision: page.InventoryRevision, TotalTaskCount: page.TotalTaskCount, TotalProjectCount: page.TotalProjectCount, SessionPartial: page.SessionPartial, Items: make([]protocol.PersonalTaskItem, 0, len(page.Items)), NextCursor: page.NextCursor}
	for _, item := range page.Items {
		var goal *protocol.PersonalTaskGoal
		if item.Task.GoalID != nil && item.Task.GoalTitle != nil {
			goal = &protocol.PersonalTaskGoal{ID: *item.Task.GoalID, Title: *item.Task.GoalTitle}
		}
		var worker *protocol.PersonalTaskWorker
		if item.Worker != nil {
			worker = &protocol.PersonalTaskWorker{WorkerID: item.Worker.WorkerID, Machine: protocol.PersonalTaskMachine{ID: item.Worker.Machine.ID, Name: item.Worker.Machine.Name}}
		}
		out.Items = append(out.Items, protocol.PersonalTaskItem{
			Project: protocol.PersonalTaskProject{ID: item.Project.ID, Name: item.Project.Name, OwnerTeam: protocol.PersonalTaskTeam{ID: item.Project.OwnerTeamID, Kind: item.Project.OwnerTeamKind, Name: item.Project.OwnerTeamName}, ExecutionWarningMinutes: int64(item.Project.ExecutionWarningMinutes), MatchedTaskCount: item.MatchedTaskCount},
			Task:    protocol.PersonalTask{ID: item.Task.ID, Version: strconv.FormatInt(item.Task.Version, 10), Title: item.Task.Title, Status: "in_progress", StartedAt: item.Task.StartedAt, AllowAgents: item.Task.AllowAgents, Paused: item.Paused, Goal: goal, Worker: worker}, Session: item.Session,
		})
	}
	return out
}

func (h personalTaskHandler) list(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", principal.UserID)
	page, err := httpx.PageRequest(request)
	if err != nil {
		httpx.WriteError(w, request, logger, "personal_tasks", "parse", err)
		return
	}
	result, err := h.run(request.Context(), principal, page.Limit, page.Cursor)
	if err != nil {
		phase := "select"
		var stage *service.PersonalTaskError
		if errors.As(err, &stage) {
			phase = stage.Phase
		}
		httpx.WriteError(w, request, logger, "personal_tasks", phase, err)
		return
	}
	if request.Context().Err() != nil {
		return
	}
	var body bytes.Buffer
	if err := json.NewEncoder(&body).Encode(personalTaskResponse(result)); err != nil {
		httpx.WriteError(w, request, logger, "personal_tasks", "encode", err)
		return
	}
	if request.Context().Err() != nil {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	n, err := w.Write(body.Bytes())
	if err == nil && n != body.Len() {
		err = io.ErrShortWrite
	}
	if err != nil {
		httpx.LogFailure(logger, request.Context(), "personal_tasks", "encode", err)
	}
}
