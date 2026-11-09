package task

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"

	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
)

func workerRoutes(mux *http.ServeMux, handler *taskHandler, auth RouteAuthentication, logger *slog.Logger) {
	path := "/api/v1/projects/{projectId}/tasks/{taskId}/worker-claim"
	mux.HandleFunc("POST "+path, auth.Require(handler.claimWorker))
	mux.HandleFunc("PATCH "+path, auth.Require(handler.updateWorker))
	mux.HandleFunc(path, auth.Require(httpx.ResourceMethodNotAllowed(logger, "POST, PATCH")))
	for _, operation := range []struct {
		path    string
		handler httpx.AuthenticatedHandler
	}{
		{"release", handler.releaseWorker},
		{"withdraw", handler.withdrawWorker},
		{"resume", handler.resumeWorker},
	} {
		mux.HandleFunc("POST "+path+"/"+operation.path, auth.Require(operation.handler))
		mux.HandleFunc(path+"/"+operation.path, auth.Require(httpx.ResourceMethodNotAllowed(logger, "POST")))
	}
}

func workerMutation[T any](h *taskHandler, w http.ResponseWriter, request *http.Request, principal model.Principal,
	phase string, allowed []string, parse func(map[string]json.RawMessage) (T, error),
	apply func(context.Context, model.Principal, string, string, T) (model.Task, error),
) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, id, logger, err := h.resource(request, principal)
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_claim", phase, err)
		return
	}
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		httpx.WriteError(w, request, logger, "worker_claim", phase, httpx.InvalidInput("worker claim operations do not accept query parameters"))
		return
	}
	fields, err := httpx.DecodeObject(w, request, allowed...)
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_claim", phase, err)
		return
	}
	input, err := parse(fields)
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_claim", phase, err)
		return
	}
	claimID, err := httpx.RequiredString(fields, "claimId")
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_claim", phase, err)
		return
	}
	task, err := apply(workerProtocolContext(request), principal, projectID, id, input)
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_claim", phase, err)
		return
	}
	logger = logger.With("claim_id", claimID)
	worker, err := taskproperties.Worker(task.Properties)
	if err != nil {
		committedResponseFailure(w, request, logger, "worker_claim", err)
		return
	}
	if worker != nil {
		logger = logger.With("worker_id", worker.WorkerID, "state", worker.State)
	}
	logger.InfoContext(request.Context(), "worker claim operation applied", "type", "resource", "component", "worker_claim", "phase", phase,
		"request_id", httpx.RequestID(request.Context()))
	writeTaskMutation(w, request, logger, "worker_claim", http.StatusOK, "", task)
}

func (h *taskHandler) claimWorker(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	workerMutation(h, w, request, principal, "claim", []string{"version", "claimId", "workerId", "machine", "platform", "agent", "agentControlMode", "worktreeId"}, claimWorkerInput, h.tasks.ClaimWorker)
}

func (h *taskHandler) updateWorker(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	workerMutation(h, w, request, principal, "update", []string{"version", "claimId", "phase", "herdr", "nativeSessionId", "startupReport"}, updateWorkerInput, h.tasks.UpdateWorker)
}

func (h *taskHandler) releaseWorker(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	workerMutation(h, w, request, principal, "release", []string{"version", "claimId", "stoppedConfirmed"}, releaseWorkerInput, h.tasks.ReleaseWorker)
}

func (h *taskHandler) withdrawWorker(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	workerMutation(h, w, request, principal, "withdraw", []string{"version", "claimId"}, withdrawWorkerInput, h.tasks.WithdrawWorker)
}

func (h *taskHandler) resumeWorker(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	workerMutation(h, w, request, principal, "resume", []string{"version", "claimId", "workerId", "machine", "platform", "agent", "agentControlMode", "worktreeId", "previousClaimId"}, resumeWorkerInput, h.tasks.ResumeWorker)
}

func workerDescriptorInput(fields map[string]json.RawMessage) (taskcore.WorkerDescriptor, error) {
	var input taskcore.WorkerDescriptor
	for key, destination := range map[string]*string{"claimId": &input.ClaimID, "workerId": &input.WorkerID, "worktreeId": &input.WorktreeID} {
		value, err := httpx.RequiredString(fields, key)
		if err != nil {
			return taskcore.WorkerDescriptor{}, err
		}
		*destination = value
	}
	machine, err := httpx.WorkerMachineInput(fields["machine"])
	if err != nil {
		return taskcore.WorkerDescriptor{}, err
	}
	input.Machine = machine
	platform, err := httpx.RequiredString(fields, "platform")
	if err != nil {
		return taskcore.WorkerDescriptor{}, err
	}
	input.Platform = model.TaskPlatform(platform)
	agent, err := httpx.RequiredString(fields, "agent")
	if err != nil {
		return taskcore.WorkerDescriptor{}, err
	}
	input.Agent = model.WorkerAgent(agent)
	input.AgentControlMode, err = workerAgentControlModeInput(fields)
	return input, err
}

func workerAgentControlModeInput(fields map[string]json.RawMessage) (model.WorkerAgentControlMode, error) {
	if _, exists := fields["agentControlMode"]; !exists {
		return model.AgentControlModeHerdr, nil
	}
	mode, err := httpx.RequiredString(fields, "agentControlMode")
	if err != nil {
		return "", err
	}
	if mode != string(model.AgentControlModeHerdr) && mode != string(model.AgentControlModeWeb) {
		return "", httpx.InvalidInput("agentControlMode must be herdr or web.")
	}
	return model.WorkerAgentControlMode(mode), nil
}

func claimWorkerInput(fields map[string]json.RawMessage) (taskcore.ClaimWorker, error) {
	var input taskcore.ClaimWorker
	var err error
	input.Version, err = httpx.VersionInput(fields)
	if err != nil {
		return taskcore.ClaimWorker{}, err
	}
	input.WorkerDescriptor, err = workerDescriptorInput(fields)
	if err != nil {
		return taskcore.ClaimWorker{}, err
	}
	return input, nil
}

func nullableWorkerHerdr(fields map[string]json.RawMessage) (**model.WorkerHerdr, error) {
	raw, exists := fields["herdr"]
	if !exists {
		return nil, nil
	}
	var value *model.WorkerHerdr
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return &value, nil
	}
	values, err := jsonobject.Decode(raw, "herdr", "session", "workspaceId", "paneId")
	if err != nil {
		return nil, httpx.InvalidInput(err.Error())
	}
	value = &model.WorkerHerdr{}
	for key, destination := range map[string]*string{"session": &value.Session, "workspaceId": &value.WorkspaceID, "paneId": &value.PaneID} {
		*destination, err = httpx.RequiredString(values, key)
		if err != nil {
			return nil, err
		}
	}
	return &value, nil
}

func nullableWorkerSession(fields map[string]json.RawMessage) (**string, error) {
	raw, exists := fields["nativeSessionId"]
	if !exists {
		return nil, nil
	}
	var value *string
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return &value, nil
	}
	value, err := httpx.OptionalString(fields, "nativeSessionId")
	return &value, err
}

func updateWorkerInput(fields map[string]json.RawMessage) (taskcore.UpdateWorker, error) {
	var input taskcore.UpdateWorker
	var err error
	input.Version, err = httpx.VersionInput(fields)
	if err != nil {
		return taskcore.UpdateWorker{}, err
	}
	input.ClaimID, err = httpx.RequiredString(fields, "claimId")
	if err != nil {
		return taskcore.UpdateWorker{}, err
	}
	phase, err := httpx.OptionalString(fields, "phase")
	if err != nil {
		return taskcore.UpdateWorker{}, err
	}
	if phase != nil {
		value := model.WorkerPhase(*phase)
		input.Phase = &value
	}
	input.Herdr, err = nullableWorkerHerdr(fields)
	if err != nil {
		return taskcore.UpdateWorker{}, err
	}
	input.NativeSessionID, err = nullableWorkerSession(fields)
	if err != nil {
		return input, err
	}
	if raw, present := fields["startupReport"]; present {
		report, parseErr := sp.DecodeStartupReport(raw)
		if parseErr != nil {
			return input, httpx.InvalidInput("Invalid startup report.")
		}
		input.StartupReport = &report
	}
	return input, err
}

func requiredWorkerConfirmation(fields map[string]json.RawMessage, key string) (bool, error) {
	value, err := httpx.OptionalBool(fields, key)
	if err != nil {
		return false, err
	}
	if value == nil {
		return false, httpx.InvalidInput(key + " is required and must be true")
	}
	return *value, nil
}

func releaseWorkerInput(fields map[string]json.RawMessage) (taskcore.ReleaseWorker, error) {
	var input taskcore.ReleaseWorker
	var err error
	input.Version, err = httpx.VersionInput(fields)
	if err != nil {
		return taskcore.ReleaseWorker{}, err
	}
	input.ClaimID, err = httpx.RequiredString(fields, "claimId")
	if err != nil {
		return taskcore.ReleaseWorker{}, err
	}
	input.StoppedConfirmed, err = requiredWorkerConfirmation(fields, "stoppedConfirmed")
	return input, err
}

func withdrawWorkerInput(fields map[string]json.RawMessage) (taskcore.WithdrawWorker, error) {
	version, err := httpx.VersionInput(fields)
	if err != nil {
		return taskcore.WithdrawWorker{}, err
	}
	claimID, err := httpx.RequiredString(fields, "claimId")
	return taskcore.WithdrawWorker{Version: version, ClaimID: claimID}, err
}

func resumeWorkerInput(fields map[string]json.RawMessage) (taskcore.ResumeWorker, error) {
	input, err := claimWorkerInput(fields)
	if err != nil {
		return taskcore.ResumeWorker{}, err
	}
	previous, err := httpx.RequiredString(fields, "previousClaimId")
	if err != nil {
		return taskcore.ResumeWorker{}, err
	}
	return taskcore.ResumeWorker{ClaimWorker: input, PreviousClaimID: previous}, nil
}
