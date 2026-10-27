package service

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type WorkerDescriptor struct {
	ClaimID    string
	WorkerID   string
	Machine    core.WorkerMachine
	Platform   core.TaskPlatform
	Agent      core.WorkerAgent
	WorktreeID string
}

type ClaimWorker struct {
	WorkerDescriptor
	Version int64
}

type UpdateWorker struct {
	Version         int64
	ClaimID         string
	Phase           *core.WorkerPhase
	Herdr           **core.WorkerHerdr
	NativeSessionID **string
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

func (s *Tasks) ClaimWorker(ctx context.Context, principal core.Principal, projectID, id string, input ClaimWorker) (core.Task, error) {
	descriptor, err := canonicalWorkerDescriptor(input.WorkerDescriptor)
	if err != nil {
		return core.Task{}, err
	}
	return s.versionedWrite(ctx, principal, projectID, id, input.Version, func(tx *store.ProjectTx, current core.Task) (taskMutation, error) {
		if err := workerReady(current); err != nil {
			return taskMutation{}, err
		}
		if !current.AllowAgents || !core.PlatformCompatible(current.RequiredPlatform, descriptor.Platform) {
			return taskMutation{}, &Fault{Code: "invalid_transition", Message: "Task does not permit automatic execution on this platform."}
		}
		if err := freshWorkerExecution(current.Properties.Worker, descriptor); err != nil {
			return taskMutation{}, err
		}
		return acquireWorker(ctx, tx, current, principal.UserID, descriptor)
	})
}

func (s *Tasks) ResumeWorker(ctx context.Context, principal core.Principal, projectID, id string, input ResumeWorker) (core.Task, error) {
	descriptor, err := canonicalWorkerDescriptor(input.WorkerDescriptor)
	if err != nil {
		return core.Task{}, err
	}
	previousID, err := CanonicalID(input.PreviousClaimID)
	if err != nil {
		return core.Task{}, err
	}
	return s.versionedWrite(ctx, principal, projectID, id, input.Version, func(tx *store.ProjectTx, current core.Task) (taskMutation, error) {
		if err := workerReady(current); err != nil {
			return taskMutation{}, err
		}
		worker := current.Properties.Worker
		if worker == nil || worker.State != core.WorkerReleased || worker.ClaimID != previousID {
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

func (s *Tasks) UpdateWorker(ctx context.Context, principal core.Principal, projectID, id string, input UpdateWorker) (core.Task, error) {
	claimID, err := CanonicalID(input.ClaimID)
	if err != nil {
		return core.Task{}, err
	}
	if input.Phase == nil && input.Herdr == nil && input.NativeSessionID == nil {
		return core.Task{}, invalidInput("At least one worker execution field must be provided.")
	}
	if input.Phase != nil && !input.Phase.Valid() {
		return core.Task{}, invalidInput("Worker phase is invalid.")
	}
	if input.Herdr != nil && *input.Herdr != nil {
		herdr := *input.Herdr
		if !workerText(herdr.Session) || !workerText(herdr.WorkspaceID) || !workerText(herdr.PaneID) {
			return core.Task{}, invalidInput("Herdr session, workspace and pane must be nonempty UTF-8 text without NUL.")
		}
	}
	if input.NativeSessionID != nil && *input.NativeSessionID != nil && !workerText(**input.NativeSessionID) {
		return core.Task{}, invalidInput("Native session ID must be null or nonempty UTF-8 text without NUL.")
	}
	return s.versionedWrite(ctx, principal, projectID, id, input.Version, func(_ *store.ProjectTx, current core.Task) (taskMutation, error) {
		worker, err := activeWorker(current, claimID)
		if err != nil {
			return taskMutation{}, err
		}
		if worker.UserID != principal.UserID {
			return taskMutation{}, &Fault{Code: "forbidden", Message: "Only the current execution owner may update worker execution."}
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
		if next.Phase == worker.Phase && equalOptional(next.Herdr, worker.Herdr) && equalOptional(next.NativeSessionID, worker.NativeSessionID) {
			return taskMutation{current: current}, nil
		}
		values := currentTaskWrite(current)
		values.Properties.Worker = &next
		return taskMutation{id: current.ID, current: current, values: values, changed: true}, nil
	})
}

func (s *Tasks) ReleaseWorker(ctx context.Context, principal core.Principal, projectID, id string, input ReleaseWorker) (core.Task, error) {
	claimID, err := CanonicalID(input.ClaimID)
	if err != nil {
		return core.Task{}, err
	}
	if !input.StoppedConfirmed {
		return core.Task{}, invalidInput("Stopped execution must be explicitly confirmed.")
	}
	return s.versionedWrite(ctx, principal, projectID, id, input.Version, func(tx *store.ProjectTx, current core.Task) (taskMutation, error) {
		worker, err := activeWorker(current, claimID)
		if err != nil {
			return taskMutation{}, err
		}
		if err := requireWorkerOperator(ctx, tx, principal, worker); err != nil {
			return taskMutation{}, err
		}
		next := *worker
		next.State = core.WorkerReleased
		values := currentTaskWrite(current)
		values.Status, values.Properties.Worker = core.TaskTodo, &next
		return taskMutation{id: current.ID, current: current, values: values, changed: true}, nil
	})
}

func (s *Tasks) WithdrawWorker(ctx context.Context, principal core.Principal, projectID, id string, input WithdrawWorker) (core.Task, error) {
	claimID, err := CanonicalID(input.ClaimID)
	if err != nil {
		return core.Task{}, err
	}
	return s.versionedWrite(ctx, principal, projectID, id, input.Version, func(tx *store.ProjectTx, current core.Task) (taskMutation, error) {
		worker := current.Properties.Worker
		if worker == nil || worker.ClaimID != claimID || (worker.State != core.WorkerActive && worker.State != core.WorkerReleased) {
			return taskMutation{}, claimConflict()
		}
		if err := requireWorkerOperator(ctx, tx, principal, worker); err != nil {
			return taskMutation{}, err
		}
		values := currentTaskWrite(current)
		values.Status, values.AllowAgents, values.Properties.Worker = core.TaskTodo, false, nil
		return taskMutation{id: current.ID, current: current, values: values, changed: true}, nil
	})
}

func canonicalWorkerDescriptor(input WorkerDescriptor) (WorkerDescriptor, error) {
	for _, field := range []*string{&input.ClaimID, &input.WorkerID, &input.Machine.ID, &input.WorktreeID} {
		value, err := CanonicalID(*field)
		if err != nil {
			return WorkerDescriptor{}, err
		}
		*field = value
	}
	if !input.Platform.Valid() || !input.Agent.Valid() || !workerText(input.Machine.Name) {
		return WorkerDescriptor{}, invalidInput("Worker requires a supported platform, agent and nonempty UTF-8 machine name without NUL.")
	}
	return input, nil
}

func workerText(value string) bool {
	return strings.TrimSpace(value) != "" && utf8.ValidString(value) && !strings.ContainsRune(value, 0)
}

func workerReady(current core.Task) error {
	if current.Status != core.TaskTodo {
		return &Fault{Code: "invalid_transition", Message: "Only a ready todo task may be claimed."}
	}
	if len(current.BlockedBy) > 0 {
		return &Fault{Code: "dependency_unsatisfied", Message: "Task prerequisites must be done.", TaskIDs: current.BlockedBy}
	}
	if current.Properties.Worker != nil && current.Properties.Worker.State == core.WorkerActive {
		return claimConflict()
	}
	return nil
}

func freshWorkerExecution(worker *core.WorkerClaim, descriptor WorkerDescriptor) error {
	if worker == nil {
		return nil
	}
	if worker.ClaimID == descriptor.ClaimID {
		return &Fault{Code: "claim_conflict", Message: "A fresh claim ID is required for a new execution."}
	}
	if worker.WorktreeID == descriptor.WorktreeID {
		return &Fault{Code: "invalid_transition", Message: "A fresh worktree ID is required for a new execution."}
	}
	return nil
}

func acquireWorker(ctx context.Context, tx *store.ProjectTx, current core.Task, userID string, descriptor WorkerDescriptor) (taskMutation, error) {
	claimedAt, err := tx.ObservedAt(ctx)
	if err != nil {
		return taskMutation{}, err
	}
	values := currentTaskWrite(current)
	values.Status = core.TaskInProgress
	values.Properties.Worker = &core.WorkerClaim{ClaimID: descriptor.ClaimID, State: core.WorkerActive, UserID: userID, WorkerID: descriptor.WorkerID, Machine: descriptor.Machine, Platform: descriptor.Platform, Agent: descriptor.Agent, WorktreeID: descriptor.WorktreeID, Phase: core.WorkerPreparing, ClaimedAt: claimedAt}
	return taskMutation{id: current.ID, current: current, values: values, changed: true}, nil
}

func activeWorker(current core.Task, claimID string) (*core.WorkerClaim, error) {
	worker := current.Properties.Worker
	if worker == nil || worker.State != core.WorkerActive || worker.ClaimID != claimID || current.Status != core.TaskInProgress {
		return nil, claimConflict()
	}
	return worker, nil
}

func claimConflict() error {
	return &Fault{Code: "claim_conflict", Message: "Task worker claim does not match the active execution."}
}

func requireWorkerOperator(ctx context.Context, tx *store.ProjectTx, principal core.Principal, worker *core.WorkerClaim) error {
	if principal.UserID == worker.UserID {
		return nil
	}
	member, err := tx.ProjectMember(ctx, principal)
	if err != nil {
		return err
	}
	return requireProjectAdmin(member)
}

func currentTaskWrite(current core.Task) store.TaskWrite {
	return store.TaskWrite{RequiredPlatform: current.RequiredPlatform, AllowAgents: current.AllowAgents, Title: current.Title, Description: current.Description, Properties: current.Properties, Status: current.Status, DependsOn: current.DependsOn, ExternalDependsOn: current.ExternalDependsOn}
}
