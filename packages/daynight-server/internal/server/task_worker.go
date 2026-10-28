package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/jsonobject"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func workerRoutes(mux *http.ServeMux, handler *taskHandler, auth *Authentication, logger *slog.Logger) {
	path := "/api/v1/projects/{projectId}/tasks/{taskId}/worker-claim"
	mux.HandleFunc("POST "+path, auth.Require(handler.claimWorker))
	mux.HandleFunc("PATCH "+path, auth.Require(handler.updateWorker))
	mux.HandleFunc(path, auth.Require(resourceMethodNotAllowed(logger, "POST, PATCH")))
	for _, operation := range []struct {
		path    string
		handler AuthenticatedHandler
	}{
		{"release", handler.releaseWorker},
		{"transfer", handler.transferWorker},
		{"resume", handler.resumeWorker},
	} {
		mux.HandleFunc("POST "+path+"/"+operation.path, auth.Require(operation.handler))
		mux.HandleFunc(path+"/"+operation.path, auth.Require(resourceMethodNotAllowed(logger, "POST")))
	}
}

func workerMutation[T any](h *taskHandler, w http.ResponseWriter, request *http.Request, principal core.Principal,
	phase string, allowed []string, parse func(map[string]json.RawMessage) (T, error),
	apply func(context.Context, core.Principal, string, string, T) (core.Task, error),
) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, id, logger, err := h.resource(request, principal)
	if err != nil {
		writeError(w, request, logger, "worker_claim", phase, err)
		return
	}
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		writeError(w, request, logger, "worker_claim", phase, invalidInput("worker claim operations do not accept query parameters"))
		return
	}
	fields, err := decodeObject(w, request, allowed...)
	if err != nil {
		writeError(w, request, logger, "worker_claim", phase, err)
		return
	}
	input, err := parse(fields)
	if err != nil {
		writeError(w, request, logger, "worker_claim", phase, err)
		return
	}
	task, err := apply(request.Context(), principal, projectID, id, input)
	if err != nil {
		writeError(w, request, logger, "worker_claim", phase, err)
		return
	}
	worker := task.Properties.Worker
	logger.InfoContext(request.Context(), "worker claim operation applied", "type", "resource", "component", "worker_claim", "phase", phase,
		"claim_id", worker.ClaimID, "worker_id", worker.WorkerID, "state", worker.State, "request_id", RequestID(request.Context()))
	writeJSON(w, request, logger, http.StatusOK, taskResponse(task))
}

func (h *taskHandler) claimWorker(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	workerMutation(h, w, request, principal, "claim", []string{"version", "claimId", "workerId", "machine", "platform", "agent", "agentControlMode", "worktreeId"}, claimWorkerInput, h.tasks.ClaimWorker)
}

func (h *taskHandler) updateWorker(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	workerMutation(h, w, request, principal, "update", []string{"version", "claimId", "phase", "herdr", "nativeSessionId"}, updateWorkerInput, h.tasks.UpdateWorker)
}

func (h *taskHandler) releaseWorker(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	workerMutation(h, w, request, principal, "release", []string{"version", "claimId", "stoppedConfirmed"}, releaseWorkerInput, h.tasks.ReleaseWorker)
}

func (h *taskHandler) transferWorker(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	workerMutation(h, w, request, principal, "transfer", []string{"version", "claimId", "newClaimId", "target", "worktreeId", "stoppedConfirmed"}, transferWorkerInput, h.tasks.TransferWorker)
}

func (h *taskHandler) resumeWorker(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	workerMutation(h, w, request, principal, "resume", []string{"version", "claimId", "workerId", "machine", "platform", "agent", "agentControlMode", "worktreeId", "previousClaimId"}, resumeWorkerInput, h.tasks.ResumeWorker)
}

func workerMachineInput(raw json.RawMessage) (core.WorkerMachine, error) {
	fields, err := jsonobject.Decode(raw, "machine", "id", "name")
	if err != nil {
		return core.WorkerMachine{}, invalidInput(err.Error())
	}
	id, err := requiredString(fields, "id")
	if err != nil {
		return core.WorkerMachine{}, err
	}
	name, err := requiredString(fields, "name")
	return core.WorkerMachine{ID: id, Name: name}, err
}

func workerDescriptorInput(fields map[string]json.RawMessage) (service.WorkerDescriptor, error) {
	var input service.WorkerDescriptor
	for key, destination := range map[string]*string{"claimId": &input.ClaimID, "workerId": &input.WorkerID, "worktreeId": &input.WorktreeID} {
		value, err := requiredString(fields, key)
		if err != nil {
			return service.WorkerDescriptor{}, err
		}
		*destination = value
	}
	machine, err := workerMachineInput(fields["machine"])
	if err != nil {
		return service.WorkerDescriptor{}, err
	}
	input.Machine = machine
	platform, err := requiredString(fields, "platform")
	if err != nil {
		return service.WorkerDescriptor{}, err
	}
	input.Platform = core.TaskPlatform(platform)
	agent, err := requiredString(fields, "agent")
	if err != nil {
		return service.WorkerDescriptor{}, err
	}
	input.Agent = core.WorkerAgent(agent)
	input.AgentControlMode, err = workerAgentControlModeInput(fields)
	return input, err
}

func workerAgentControlModeInput(fields map[string]json.RawMessage) (core.WorkerAgentControlMode, error) {
	if _, exists := fields["agentControlMode"]; !exists {
		return core.AgentControlModeHerdr, nil
	}
	mode, err := requiredString(fields, "agentControlMode")
	if err != nil {
		return "", err
	}
	if mode != string(core.AgentControlModeHerdr) && mode != string(core.AgentControlModeWeb) {
		return "", invalidInput("agentControlMode must be herdr or web.")
	}
	return core.WorkerAgentControlMode(mode), nil
}

func claimWorkerInput(fields map[string]json.RawMessage) (service.ClaimWorker, error) {
	var input service.ClaimWorker
	var err error
	input.Version, err = versionInput(fields)
	if err != nil {
		return service.ClaimWorker{}, err
	}
	input.WorkerDescriptor, err = workerDescriptorInput(fields)
	if err != nil {
		return service.ClaimWorker{}, err
	}
	return input, nil
}

func nullableWorkerHerdr(fields map[string]json.RawMessage) (**core.WorkerHerdr, error) {
	raw, exists := fields["herdr"]
	if !exists {
		return nil, nil
	}
	var value *core.WorkerHerdr
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return &value, nil
	}
	values, err := jsonobject.Decode(raw, "herdr", "session", "workspaceId", "paneId")
	if err != nil {
		return nil, invalidInput(err.Error())
	}
	value = &core.WorkerHerdr{}
	for key, destination := range map[string]*string{"session": &value.Session, "workspaceId": &value.WorkspaceID, "paneId": &value.PaneID} {
		*destination, err = requiredString(values, key)
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
	value, err := optionalString(fields, "nativeSessionId")
	return &value, err
}

func updateWorkerInput(fields map[string]json.RawMessage) (service.UpdateWorker, error) {
	var input service.UpdateWorker
	var err error
	input.Version, err = versionInput(fields)
	if err != nil {
		return service.UpdateWorker{}, err
	}
	input.ClaimID, err = requiredString(fields, "claimId")
	if err != nil {
		return service.UpdateWorker{}, err
	}
	phase, err := optionalString(fields, "phase")
	if err != nil {
		return service.UpdateWorker{}, err
	}
	if phase != nil {
		value := core.WorkerPhase(*phase)
		input.Phase = &value
	}
	input.Herdr, err = nullableWorkerHerdr(fields)
	if err != nil {
		return service.UpdateWorker{}, err
	}
	input.NativeSessionID, err = nullableWorkerSession(fields)
	return input, err
}

func requiredWorkerConfirmation(fields map[string]json.RawMessage, key string) (bool, error) {
	value, err := optionalBool(fields, key)
	if err != nil {
		return false, err
	}
	if value == nil {
		return false, invalidInput(key + " is required and must be true")
	}
	return *value, nil
}

func releaseWorkerInput(fields map[string]json.RawMessage) (service.ReleaseWorker, error) {
	var input service.ReleaseWorker
	var err error
	input.Version, err = versionInput(fields)
	if err != nil {
		return service.ReleaseWorker{}, err
	}
	input.ClaimID, err = requiredString(fields, "claimId")
	if err != nil {
		return service.ReleaseWorker{}, err
	}
	input.StoppedConfirmed, err = requiredWorkerConfirmation(fields, "stoppedConfirmed")
	return input, err
}

func transferWorkerInput(fields map[string]json.RawMessage) (service.TransferWorker, error) {
	var input service.TransferWorker
	var err error
	input.Version, err = versionInput(fields)
	if err != nil {
		return service.TransferWorker{}, err
	}
	for key, destination := range map[string]*string{"claimId": &input.ClaimID, "newClaimId": &input.NewClaimID, "worktreeId": &input.WorktreeID} {
		*destination, err = requiredString(fields, key)
		if err != nil {
			return service.TransferWorker{}, err
		}
	}
	target, err := jsonobject.Decode(fields["target"], "target", "userId", "workerId", "machine", "platform", "agent", "agentControlMode")
	if err != nil {
		return service.TransferWorker{}, invalidInput(err.Error())
	}
	input.Target.UserID, err = requiredString(target, "userId")
	if err != nil {
		return service.TransferWorker{}, err
	}
	input.Target.WorkerID, err = requiredString(target, "workerId")
	if err != nil {
		return service.TransferWorker{}, err
	}
	input.Target.Machine, err = workerMachineInput(target["machine"])
	if err != nil {
		return service.TransferWorker{}, err
	}
	platform, err := requiredString(target, "platform")
	if err != nil {
		return service.TransferWorker{}, err
	}
	input.Target.Platform = core.TaskPlatform(platform)
	agent, err := requiredString(target, "agent")
	if err != nil {
		return service.TransferWorker{}, err
	}
	input.Target.Agent = core.WorkerAgent(agent)
	input.Target.AgentControlMode, err = workerAgentControlModeInput(target)
	if err != nil {
		return service.TransferWorker{}, err
	}
	input.StoppedConfirmed, err = requiredWorkerConfirmation(fields, "stoppedConfirmed")
	return input, err
}

func resumeWorkerInput(fields map[string]json.RawMessage) (service.ResumeWorker, error) {
	input, err := claimWorkerInput(fields)
	if err != nil {
		return service.ResumeWorker{}, err
	}
	previous, err := requiredString(fields, "previousClaimId")
	if err != nil {
		return service.ResumeWorker{}, err
	}
	return service.ResumeWorker{ClaimWorker: input, PreviousClaimID: previous}, nil
}
