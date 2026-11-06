package bot

import (
	"context"
	"fmt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	"time"
)

// BotDefaults is an observation, not a reservation or a startup guarantee.
type BotDefaults struct {
	ObservedAt    time.Time
	WorkerID      *string
	Configuration *model.BotConfiguration
	Reason        *string
	Workers       []BotWorkerDefaults
}

type BotWorkerDefaults struct {
	WorkerID      string
	Machine       model.WorkerMachine
	Platform      model.TaskPlatform
	State         string
	Reason        *string
	Configuration *model.BotConfiguration
	Providers     []model.WorkerAssistantProvider
}

func ResolveBotDefaults(input model.BotDefaultsInput, overrides model.BotOverrides) (BotDefaults, error) {
	result := BotDefaults{ObservedAt: input.ObservedAt, Workers: make([]BotWorkerDefaults, 0, len(input.Workers))}
	for _, worker := range input.Workers {
		result.Workers = append(result.Workers, resolveBotWorker(worker, input.ObservedAt, input.WorkerPreferences[worker.WorkerID], overrides))
	}
	if overrides.WorkerID != nil {
		for _, worker := range result.Workers {
			if worker.WorkerID == *overrides.WorkerID {
				return selectBotWorker(result, worker), nil
			}
		}
		return BotDefaults{}, botForbidden()
	}
	if input.PreferredWorkerID != nil {
		for _, worker := range result.Workers {
			if worker.WorkerID == *input.PreferredWorkerID && worker.Configuration != nil {
				return selectBotWorker(result, worker), nil
			}
		}
	}
	for _, worker := range result.Workers {
		if worker.Configuration != nil {
			return selectBotWorker(result, worker), nil
		}
	}
	reason := "no_available_worker"
	result.Reason = &reason
	return result, nil
}

func selectBotWorker(result BotDefaults, worker BotWorkerDefaults) BotDefaults {
	result.WorkerID = &worker.WorkerID
	result.Configuration = worker.Configuration
	result.Reason = worker.Reason
	return result
}

func resolveBotWorker(worker model.WorkerSnapshot, now time.Time, preference model.BotWorkerPreference, overrides model.BotOverrides) BotWorkerDefaults {
	result := BotWorkerDefaults{WorkerID: worker.WorkerID, Machine: worker.Telemetry.Machine, Platform: worker.Telemetry.Platform,
		State: workercore.WorkerAssistantHostState(worker, now), Providers: []model.WorkerAssistantProvider{}}
	host := worker.Telemetry.AssistantHost
	if host != nil {
		result.Providers = host.Providers
	}
	if result.State != "available" {
		result.Reason = &result.State
		return result
	}
	cwd := host.DefaultCwd
	if preference.Cwd != nil {
		cwd = *preference.Cwd
	}
	if overrides.Cwd != nil {
		cwd = *overrides.Cwd
	}
	if !workercore.AssistantAbsolutePath(cwd, worker.Telemetry.Platform) {
		reason := "invalid_cwd"
		result.Reason = &reason
		return result
	}
	provider := string(host.DefaultProvider)
	if preference.Provider != nil {
		provider = *preference.Provider
	}
	if overrides.Provider != nil {
		provider = *overrides.Provider
	}
	for _, candidate := range host.Providers {
		if string(candidate.Provider) != provider {
			continue
		}
		if !candidate.Available {
			reason := "provider_unavailable"
			if candidate.Reason != nil {
				reason = "provider_" + *candidate.Reason
			}
			result.Reason = &reason
			return result
		}
		// Model and arguments always come from this Worker's selected provider.
		result.Configuration = &model.BotConfiguration{WorkerID: worker.WorkerID, Cwd: cwd, Provider: provider, Model: candidate.Model, Args: append([]string{}, candidate.Args...)}
		return result
	}
	reason := "provider_unavailable"
	result.Reason = &reason
	return result
}

func resolveBotCreation(ctx context.Context, tx store.BotWriteDAO, principal model.Principal, input CreateBot) (model.BotConfiguration, error) {
	defaults, err := tx.BotDefaults(ctx, principal.UserID)
	if err != nil {
		return model.BotConfiguration{}, err
	}
	resolved, err := ResolveBotDefaults(defaults, input.Overrides)
	if err != nil {
		return model.BotConfiguration{}, err
	}
	if resolved.Configuration == nil {
		return model.BotConfiguration{}, botConflict(fmt.Sprintf("Bot configuration is unavailable: %s. Read current defaults before submitting a new request.", *resolved.Reason))
	}
	return *resolved.Configuration, nil
}

// Defaults reads current owner-scoped choices without recording a preference.
func Defaults(ctx context.Context, snapshot store.SnapshotScope, principal model.Principal, workerID *string) (BotDefaults, error) {
	if _, err := snapshot.CredentialDAO().Credential(ctx, principal); err != nil {
		return BotDefaults{}, botCredentialError(err)
	}
	input, err := snapshot.BotDAO().BotDefaults(ctx, principal.UserID)
	if err != nil {
		return BotDefaults{}, err
	}
	return ResolveBotDefaults(input, model.BotOverrides{WorkerID: workerID})
}
