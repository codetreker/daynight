package bot

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
)

// CreationDefaults selects one owner Worker without constructing the defaults directory.
// Candidate and final reads share the caller's snapshot or creation transaction.
func CreationDefaults(ctx context.Context, reader store.BotCreationReader, ownerID string, overrides model.BotOverrides) (model.BotDefaultsInput, BotDefaults, error) {
	if err := NormalizeOverrides(overrides); err != nil {
		return model.BotDefaultsInput{}, BotDefaults{}, err
	}
	if overrides.WorkerID != nil {
		input, err := reader.BotCreationWorker(ctx, ownerID, *overrides.WorkerID)
		if err != nil {
			return model.BotDefaultsInput{}, BotDefaults{}, err
		}
		resolved, err := ResolveBotDefaults(input, overrides)
		if err != nil {
			return model.BotDefaultsInput{}, BotDefaults{}, err
		}
		return input, resolved, nil
	}

	// Evaluate small projections with the same resolver used for the complete
	// directory. Only an eligible choice requires its full native configuration.
	try := func(input model.BotDefaultsInput, id string) (model.BotDefaultsInput, BotDefaults, bool, error) {
		if len(input.Workers) == 0 {
			return model.BotDefaultsInput{}, BotDefaults{}, false, nil
		}
		choice := overrides
		choice.WorkerID = &id
		single := input
		single.Workers = nil
		for _, worker := range input.Workers {
			if worker.WorkerID == id {
				single.Workers = []model.WorkerSnapshot{worker}
				break
			}
		}
		if len(single.Workers) == 0 {
			return model.BotDefaultsInput{}, BotDefaults{}, false, nil
		}
		candidate, err := ResolveBotDefaults(single, choice)
		if err != nil {
			return model.BotDefaultsInput{}, BotDefaults{}, false, err
		}
		if candidate.Configuration == nil {
			return model.BotDefaultsInput{}, BotDefaults{}, false, nil
		}
		full, err := reader.BotCreationWorker(ctx, ownerID, id)
		if err != nil {
			return model.BotDefaultsInput{}, BotDefaults{}, false, err
		}
		if len(full.Workers) == 0 {
			return model.BotDefaultsInput{}, BotDefaults{}, false, nil
		}
		resolved, err := ResolveBotDefaults(full, choice)
		if err != nil {
			return model.BotDefaultsInput{}, BotDefaults{}, false, err
		}
		return full, resolved, resolved.Configuration != nil, nil
	}

	preferred, err := reader.BotPreferredWorker(ctx, ownerID)
	if err != nil {
		return model.BotDefaultsInput{}, BotDefaults{}, err
	}
	if preferred != nil {
		candidate, err := reader.BotCreationCandidate(ctx, ownerID, *preferred)
		if err != nil {
			return model.BotDefaultsInput{}, BotDefaults{}, err
		}
		input, result, found, err := try(candidate, *preferred)
		if err != nil || found {
			return input, result, err
		}
	}
	candidates, err := reader.BotCreationCandidates(ctx, ownerID)
	if err != nil {
		return model.BotDefaultsInput{}, BotDefaults{}, err
	}
	if len(candidates.Workers) > workercore.MaxActiveWorkers {
		return model.BotDefaultsInput{}, BotDefaults{}, &model.Fault{Code: "active_worker_limit_exceeded", Message: "Active worker limit exceeded."}
	}
	// The preferred Worker may have become available between its targeted read
	// and the scan in a ReadCommitted transaction. Apply preference again to
	// the scan's own observation before considering registration order.
	if preferred != nil {
		input, result, found, err := try(candidates, *preferred)
		if err != nil || found {
			return input, result, err
		}
	}
	for _, worker := range candidates.Workers {
		if preferred != nil && worker.WorkerID == *preferred {
			continue
		}
		input, result, found, err := try(candidates, worker.WorkerID)
		if err != nil || found {
			return input, result, err
		}
	}
	reason := "no_available_worker"
	return model.BotDefaultsInput{}, BotDefaults{ObservedAt: candidates.ObservedAt, Reason: &reason}, nil
}
