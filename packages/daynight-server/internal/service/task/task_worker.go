package task

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func (s *Tasks) ClaimWorker(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.ClaimWorker) (model.Task, error) {
	descriptor, err := taskcore.CanonicalWorkerDescriptor(input.WorkerDescriptor)
	if err != nil {
		return model.Task{}, err
	}
	if err := taskcore.RequireCompatibleWorker(ctx, &model.WorkerClaim{Agent: descriptor.Agent, AgentControlMode: descriptor.AgentControlMode}); err != nil {
		return model.Task{}, err
	}
	return s.versionedWrite(ctx, principal, projectID, id, input.Version, func(tx store.ProjectWriteScope, current model.Task) (taskcore.Mutation, error) {
		if err := taskcore.ClaimAdmission(current, principal.UserID, descriptor); err != nil {
			return taskcore.Mutation{}, err
		}
		if err := taskcore.ClaimParentAdmission(ctx, tx.TaskDAO(), current); err != nil {
			return taskcore.Mutation{}, err
		}
		return acquireWorker(ctx, tx, current, principal.UserID, descriptor)
	})
}

func (s *Tasks) ResumeWorker(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.ResumeWorker) (model.Task, error) {
	descriptor, err := taskcore.CanonicalWorkerDescriptor(input.WorkerDescriptor)
	if err != nil {
		return model.Task{}, err
	}
	if err := taskcore.RequireCompatibleWorker(ctx, &model.WorkerClaim{Agent: descriptor.Agent, AgentControlMode: descriptor.AgentControlMode}); err != nil {
		return model.Task{}, err
	}
	previousID, err := model.CanonicalID(input.PreviousClaimID)
	if err != nil {
		return model.Task{}, err
	}
	return s.versionedWrite(ctx, principal, projectID, id, input.Version, func(tx store.ProjectWriteScope, current model.Task) (taskcore.Mutation, error) {
		worker, err := taskcore.ReleasedWorker(current, previousID)
		if err != nil {
			return taskcore.Mutation{}, err
		}
		if err := requireWorkerOperator(ctx, tx, principal, worker); err != nil {
			return taskcore.Mutation{}, err
		}
		if err := taskcore.FreshWorkerExecution(worker, descriptor); err != nil {
			return taskcore.Mutation{}, err
		}
		return acquireWorker(ctx, tx, current, principal.UserID, descriptor)
	})
}

func (s *Tasks) UpdateWorker(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.UpdateWorker) (model.Task, error) {
	claimID, err := taskcore.ValidateWorkerUpdate(input)
	if err != nil {
		return model.Task{}, err
	}
	return s.versionedWrite(ctx, principal, projectID, id, input.Version, func(tx store.ProjectWriteScope, current model.Task) (taskcore.Mutation, error) {
		worker, err := taskcore.ActiveWorker(current, claimID)
		if err != nil {
			return taskcore.Mutation{}, err
		}
		if err := taskcore.WorkerUpdateAdmission(worker, principal.UserID, claimID, input); err != nil {
			return taskcore.Mutation{}, err
		}
		if input.StartupReport != nil {
			matched, err := tx.SessionDAO().MatchSessionStartup(ctx, current.ID, worker, *input.StartupReport)
			if err != nil {
				return taskcore.Mutation{}, err
			}
			if !matched {
				return taskcore.Mutation{}, taskcore.ClaimConflict()
			}
		}
		values, changed, err := taskcore.WorkerUpdateCandidate(current, worker, claimID, input)
		if err != nil {
			return taskcore.Mutation{}, err
		}
		return taskcore.Mutation{ID: current.ID, Current: current, Values: values, Changed: changed}, nil
	})
}

func (s *Tasks) ReleaseWorker(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.ReleaseWorker) (model.Task, error) {
	claimID, err := model.CanonicalID(input.ClaimID)
	if err != nil {
		return model.Task{}, err
	}
	if !input.StoppedConfirmed {
		return model.Task{}, invalidInput("Stopped execution must be explicitly confirmed.")
	}
	return s.versionedWrite(ctx, principal, projectID, id, input.Version, func(tx store.ProjectWriteScope, current model.Task) (taskcore.Mutation, error) {
		worker, err := taskcore.ActiveWorker(current, claimID)
		if err != nil {
			return taskcore.Mutation{}, err
		}
		if err := requireWorkerOperator(ctx, tx, principal, worker); err != nil {
			return taskcore.Mutation{}, err
		}
		values, err := taskcore.ReleaseCandidate(current, worker)
		if err != nil {
			return taskcore.Mutation{}, err
		}
		return taskcore.Mutation{ID: current.ID, Current: current, Values: values, Changed: true}, nil
	})
}

func (s *Tasks) WithdrawWorker(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.WithdrawWorker) (model.Task, error) {
	claimID, err := model.CanonicalID(input.ClaimID)
	if err != nil {
		return model.Task{}, err
	}
	return s.versionedWrite(ctx, principal, projectID, id, input.Version, func(tx store.ProjectWriteScope, current model.Task) (taskcore.Mutation, error) {
		worker, err := taskcore.WithdrawableWorker(current, claimID)
		if err != nil {
			return taskcore.Mutation{}, err
		}
		if err := requireWorkerOperator(ctx, tx, principal, worker); err != nil {
			return taskcore.Mutation{}, err
		}
		values, err := taskcore.WithdrawCandidate(current)
		if err != nil {
			return taskcore.Mutation{}, err
		}
		return taskcore.Mutation{ID: current.ID, Current: current, Values: values, Changed: true}, nil
	})
}

func acquireWorker(ctx context.Context, tx store.ProjectWriteScope, current model.Task, userID string, descriptor taskcore.WorkerDescriptor) (taskcore.Mutation, error) {
	claimedAt, err := tx.TaskDAO().ObservedAt(ctx)
	if err != nil {
		return taskcore.Mutation{}, err
	}
	values, err := taskcore.AcquireWorker(current, userID, descriptor, claimedAt)
	if err != nil {
		return taskcore.Mutation{}, err
	}
	return taskcore.Mutation{ID: current.ID, Current: current, Values: values, Changed: true}, nil
}

func requireWorkerOperator(ctx context.Context, tx store.ProjectWriteScope, principal model.Principal, worker *model.WorkerClaim) error {
	if principal.UserID == worker.UserID {
		return nil
	}
	access, err := tx.ProjectDAO().ProjectAccess(ctx, principal)
	if err != nil {
		return err
	}
	return projectcore.RequireProjectAdmin(access)
}
