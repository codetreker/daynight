package service

import (
	"context"
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
)

type WorkerDescriptor struct {
	ClaimID          string
	WorkerID         string
	Machine          model.WorkerMachine
	Platform         model.TaskPlatform
	Agent            model.WorkerAgent
	AgentControlMode model.WorkerAgentControlMode
	WorktreeID       string
}

type ClaimWorker struct {
	WorkerDescriptor
	Version int64
}

type UpdateWorker struct {
	Version         int64
	ClaimID         string
	Phase           *model.WorkerPhase
	Herdr           **model.WorkerHerdr
	NativeSessionID **string
	StartupReport   *sp.StartupReport
}

type ReleaseWorker struct {
	Version          int64
	ClaimID          string
	StoppedConfirmed bool
}

type WithdrawWorker struct {
	Version int64
	ClaimID string
}

type ResumeWorker struct {
	ClaimWorker
	PreviousClaimID string
}

func (s *Tasks) ClaimWorker(ctx context.Context, principal model.Principal, projectID, id string, input ClaimWorker) (model.Task, error) {
	descriptor, err := canonicalWorkerDescriptor(input.WorkerDescriptor)
	if err != nil {
		return model.Task{}, err
	}
	if err := requireCompatibleWorker(ctx, &model.WorkerClaim{Agent: descriptor.Agent, AgentControlMode: descriptor.AgentControlMode}); err != nil {
		return model.Task{}, err
	}
	return s.versionedWrite(ctx, principal, projectID, id, input.Version, func(tx *store.ProjectTx, current model.Task) (taskMutation, error) {
		if err := workerReady(current); err != nil {
			return taskMutation{}, err
		}
		if current.AssignedTo == nil || *current.AssignedTo != principal.UserID {
			return taskMutation{}, &model.Fault{Code: "invalid_transition", Message: "Task must be assigned to the authenticated user for automatic execution."}
		}
		if !current.AllowAgents || !model.PlatformCompatible(current.RequiredPlatform, descriptor.Platform) {
			return taskMutation{}, &model.Fault{Code: "invalid_transition", Message: "Task does not permit automatic execution on this platform."}
		}
		worker, err := taskproperties.Worker(current.Properties)
		if err != nil {
			return taskMutation{}, err
		}
		if err := freshWorkerExecution(worker, descriptor); err != nil {
			return taskMutation{}, err
		}
		return acquireWorker(ctx, tx, current, principal.UserID, descriptor)
	})
}

func (s *Tasks) ResumeWorker(ctx context.Context, principal model.Principal, projectID, id string, input ResumeWorker) (model.Task, error) {
	descriptor, err := canonicalWorkerDescriptor(input.WorkerDescriptor)
	if err != nil {
		return model.Task{}, err
	}
	if err := requireCompatibleWorker(ctx, &model.WorkerClaim{Agent: descriptor.Agent, AgentControlMode: descriptor.AgentControlMode}); err != nil {
		return model.Task{}, err
	}
	previousID, err := CanonicalID(input.PreviousClaimID)
	if err != nil {
		return model.Task{}, err
	}
	return s.versionedWrite(ctx, principal, projectID, id, input.Version, func(tx *store.ProjectTx, current model.Task) (taskMutation, error) {
		if err := workerReady(current); err != nil {
			return taskMutation{}, err
		}
		worker, err := taskproperties.Worker(current.Properties)
		if err != nil {
			return taskMutation{}, err
		}
		if worker == nil || worker.State != model.WorkerReleased || worker.ClaimID != previousID {
			return taskMutation{}, claimConflict()
		}
		if err := requireWorkerOperator(ctx, tx, principal, worker); err != nil {
			return taskMutation{}, err
		}
		if err := freshWorkerExecution(worker, descriptor); err != nil {
			return taskMutation{}, err
		}
		return acquireWorker(ctx, tx, current, principal.UserID, descriptor)
	})
}

func (s *Tasks) UpdateWorker(ctx context.Context, principal model.Principal, projectID, id string, input UpdateWorker) (model.Task, error) {
	claimID, err := CanonicalID(input.ClaimID)
	if err != nil {
		return model.Task{}, err
	}
	if input.Phase == nil && input.Herdr == nil && input.NativeSessionID == nil && input.StartupReport == nil {
		return model.Task{}, invalidInput("At least one worker execution field must be provided.")
	}
	if input.Phase != nil && !input.Phase.Valid() {
		return model.Task{}, invalidInput("Worker phase is invalid.")
	}
	if input.Herdr != nil && *input.Herdr != nil {
		herdr := *input.Herdr
		if !workerText(herdr.Session) || !workerText(herdr.WorkspaceID) || !workerText(herdr.PaneID) {
			return model.Task{}, invalidInput("Herdr session, workspace and pane must be nonempty UTF-8 text without NUL.")
		}
	}
	if input.NativeSessionID != nil && *input.NativeSessionID != nil && !workerText(**input.NativeSessionID) {
		return model.Task{}, invalidInput("Native session ID must be null or nonempty UTF-8 text without NUL.")
	}
	if input.StartupReport != nil {
		raw, err := json.Marshal(input.StartupReport)
		if err != nil {
			return model.Task{}, invalidInput("Invalid startup report.")
		}
		if _, err = sp.DecodeStartupReport(raw); err != nil {
			return model.Task{}, invalidInput("Invalid startup report.")
		}
	}
	return s.versionedWrite(ctx, principal, projectID, id, input.Version, func(tx *store.ProjectTx, current model.Task) (taskMutation, error) {
		worker, err := activeWorker(current, claimID)
		if err != nil {
			return taskMutation{}, err
		}
		if worker.UserID != principal.UserID {
			return taskMutation{}, &model.Fault{Code: "forbidden", Message: "Only the current execution owner may update worker execution."}
		}
		if worker.AgentControlMode == model.AgentControlModeWeb && input.Herdr != nil && *input.Herdr != nil {
			return taskMutation{}, invalidInput("Web execution cannot bind Herdr resources.")
		}
		reportChanged := false
		if input.StartupReport != nil {
			if worker.AgentControlMode != model.AgentControlModeWeb || input.StartupReport.ClaimID != claimID {
				return taskMutation{}, claimConflict()
			}
			matched, err := tx.MatchSessionStartup(ctx, current.ID, worker, *input.StartupReport)
			if err != nil {
				return taskMutation{}, err
			}
			if !matched {
				return taskMutation{}, claimConflict()
			}
			previous, err := taskproperties.SessionStartup(current.Properties)
			if err != nil {
				return taskMutation{}, err
			}
			reportChanged = !reflect.DeepEqual(previous, input.StartupReport)
			if previous != nil && previous.ClaimID == claimID && previous.SessionID == input.StartupReport.SessionID && previous.ExecutionGeneration == input.StartupReport.ExecutionGeneration && previous.ControllerInstanceID == input.StartupReport.ControllerInstanceID {
				before, _ := strconv.ParseInt(previous.Revision, 10, 64)
				after, _ := strconv.ParseInt(input.StartupReport.Revision, 10, 64)
				if after < before || after == before && reportChanged {
					return taskMutation{}, claimConflict()
				}
			}
		}
		next := *worker
		if input.Phase != nil {
			next.Phase = *input.Phase
		}
		if input.Herdr != nil {
			next.Herdr = *input.Herdr
		}
		if input.NativeSessionID != nil {
			next.NativeSessionID = *input.NativeSessionID
		}
		if !reportChanged && next.Phase == worker.Phase && equalOptional(next.Herdr, worker.Herdr) && equalOptional(next.NativeSessionID, worker.NativeSessionID) {
			return taskMutation{current: current}, nil
		}
		values := currentTaskWrite(current)
		values.Properties, err = taskproperties.WithWorker(values.Properties, &next)
		if err != nil {
			return taskMutation{}, err
		}
		if reportChanged {
			values.Properties["sessionStartup"], err = json.Marshal(input.StartupReport)
			if err != nil {
				return taskMutation{}, err
			}
		}
		return taskMutation{id: current.ID, current: current, values: values, changed: true}, nil
	})
}

func (s *Tasks) ReleaseWorker(ctx context.Context, principal model.Principal, projectID, id string, input ReleaseWorker) (model.Task, error) {
	claimID, err := CanonicalID(input.ClaimID)
	if err != nil {
		return model.Task{}, err
	}
	if !input.StoppedConfirmed {
		return model.Task{}, invalidInput("Stopped execution must be explicitly confirmed.")
	}
	return s.versionedWrite(ctx, principal, projectID, id, input.Version, func(tx *store.ProjectTx, current model.Task) (taskMutation, error) {
		worker, err := activeWorker(current, claimID)
		if err != nil {
			return taskMutation{}, err
		}
		if err := requireWorkerOperator(ctx, tx, principal, worker); err != nil {
			return taskMutation{}, err
		}
		next := *worker
		next.State = model.WorkerReleased
		values := currentTaskWrite(current)
		values.Status = model.TaskTodo
		values.Properties, err = taskproperties.WithWorker(values.Properties, &next)
		if err != nil {
			return taskMutation{}, err
		}
		return taskMutation{id: current.ID, current: current, values: values, changed: true}, nil
	})
}

func (s *Tasks) WithdrawWorker(ctx context.Context, principal model.Principal, projectID, id string, input WithdrawWorker) (model.Task, error) {
	claimID, err := CanonicalID(input.ClaimID)
	if err != nil {
		return model.Task{}, err
	}
	return s.versionedWrite(ctx, principal, projectID, id, input.Version, func(tx *store.ProjectTx, current model.Task) (taskMutation, error) {
		worker, err := taskproperties.Worker(current.Properties)
		if err != nil {
			return taskMutation{}, err
		}
		if worker == nil || worker.ClaimID != claimID || (worker.State != model.WorkerActive && worker.State != model.WorkerReleased) {
			return taskMutation{}, claimConflict()
		}
		if err := requireWorkerOperator(ctx, tx, principal, worker); err != nil {
			return taskMutation{}, err
		}
		values := currentTaskWrite(current)
		values.Status, values.AllowAgents = model.TaskTodo, false
		values.Properties, err = taskproperties.WithWorker(values.Properties, nil)
		if err != nil {
			return taskMutation{}, err
		}
		return taskMutation{id: current.ID, current: current, values: values, changed: true}, nil
	})
}

func canonicalWorkerDescriptor(input WorkerDescriptor) (WorkerDescriptor, error) {
	if input.AgentControlMode == "" {
		input.AgentControlMode = model.AgentControlModeHerdr
	}
	for _, field := range []*string{&input.ClaimID, &input.WorkerID, &input.Machine.ID, &input.WorktreeID} {
		value, err := CanonicalID(*field)
		if err != nil {
			return WorkerDescriptor{}, err
		}
		*field = value
	}
	if !input.Platform.Valid() || !input.AgentControlMode.Supports(input.Agent) || !workerText(input.Machine.Name) {
		return WorkerDescriptor{}, invalidInput("Worker requires a supported platform, agent/control mode combination and nonempty UTF-8 machine name without NUL.")
	}
	return input, nil
}

func workerText(value string) bool {
	return strings.TrimSpace(value) != "" && utf8.ValidString(value) && !strings.ContainsRune(value, 0)
}

func workerReady(current model.Task) error {
	if current.Status != model.TaskTodo {
		return &model.Fault{Code: "invalid_transition", Message: "Only a ready todo task may be claimed."}
	}
	if len(current.BlockedBy) > 0 {
		return &model.Fault{Code: "dependency_unsatisfied", Message: "Task prerequisites must be done.", TaskIDs: current.BlockedBy}
	}
	worker, err := taskproperties.Worker(current.Properties)
	if err != nil {
		return err
	}
	if worker != nil && worker.State == model.WorkerActive {
		return claimConflict()
	}
	return nil
}

func freshWorkerExecution(worker *model.WorkerClaim, descriptor WorkerDescriptor) error {
	if worker == nil {
		return nil
	}
	if worker.ClaimID == descriptor.ClaimID {
		return &model.Fault{Code: "claim_conflict", Message: "A fresh claim ID is required for a new execution."}
	}
	if worker.WorktreeID == descriptor.WorktreeID {
		return &model.Fault{Code: "invalid_transition", Message: "A fresh worktree ID is required for a new execution."}
	}
	return nil
}

func acquireWorker(ctx context.Context, tx *store.ProjectTx, current model.Task, userID string, descriptor WorkerDescriptor) (taskMutation, error) {
	claimedAt, err := tx.ObservedAt(ctx)
	if err != nil {
		return taskMutation{}, err
	}
	values := currentTaskWrite(current)
	delete(values.Properties, "sessionStartup")
	values.Status = model.TaskInProgress
	values.Properties, err = taskproperties.WithWorker(values.Properties, &model.WorkerClaim{ClaimID: descriptor.ClaimID, State: model.WorkerActive, UserID: userID, WorkerID: descriptor.WorkerID, Machine: descriptor.Machine, Platform: descriptor.Platform, Agent: descriptor.Agent, AgentControlMode: descriptor.AgentControlMode, WorktreeID: descriptor.WorktreeID, Phase: model.WorkerPreparing, ClaimedAt: claimedAt})
	if err != nil {
		return taskMutation{}, err
	}
	return taskMutation{id: current.ID, current: current, values: values, changed: true}, nil
}

func activeWorker(current model.Task, claimID string) (*model.WorkerClaim, error) {
	worker, err := taskproperties.Worker(current.Properties)
	if err != nil {
		return nil, err
	}
	if worker == nil || worker.State != model.WorkerActive || worker.ClaimID != claimID || current.Status != model.TaskInProgress {
		return nil, claimConflict()
	}
	return worker, nil
}

func claimConflict() error {
	return &model.Fault{Code: "claim_conflict", Message: "Task worker claim does not match the active execution."}
}

func requireWorkerOperator(ctx context.Context, tx *store.ProjectTx, principal model.Principal, worker *model.WorkerClaim) error {
	if principal.UserID == worker.UserID {
		return nil
	}
	access, err := tx.ProjectAccess(ctx, principal)
	if err != nil {
		return err
	}
	return requireProjectAdmin(access)
}
