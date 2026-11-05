package service

import (
	"context"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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

// Defaults reads current owner-scoped choices without recording a preference.
func (s *Bots) Defaults(ctx context.Context, principal model.Principal, workerID *string) (BotDefaults, error) {
	if err := requirePrincipal(principal); err != nil {
		return BotDefaults{}, err
	}
	if workerID != nil {
		id, err := CanonicalID(*workerID)
		if err != nil {
			return BotDefaults{}, err
		}
		workerID = &id
	}
	var result BotDefaults
	err := s.store.ReadSnapshot(ctx, func(snapshot *store.Snapshot) error {
		if _, err := snapshot.Credential(ctx, principal); err != nil {
			return botCredentialError(err)
		}
		input, err := snapshot.BotDefaults(ctx, principal.UserID)
		if err != nil {
			return err
		}
		result, err = resolveBotDefaults(input, model.BotOverrides{WorkerID: workerID})
		return err
	})
	if err != nil {
		return BotDefaults{}, botResultError("defaults", err)
	}
	return result, nil
}

// CreateResolved resolves only the original missing identity. Identical retries
// return the persisted definition even when its Worker is no longer available.
func (s *Bots) CreateResolved(ctx context.Context, principal model.Principal, input CreateBot) (model.Bot, error) {
	return s.create(ctx, principal, input, true)
}

func resolveBotDefaults(input model.BotDefaultsInput, overrides model.BotOverrides) (BotDefaults, error) {
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
		State: WorkerAssistantHostState(worker, now), Providers: []model.WorkerAssistantProvider{}}
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
	if !workerAssistantAbsolutePath(cwd, worker.Telemetry.Platform) {
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

func resolveBotCreation(ctx context.Context, tx *store.BotTx, principal model.Principal, input CreateBot) (model.BotConfiguration, error) {
	defaults, err := tx.BotDefaults(ctx, principal.UserID)
	if err != nil {
		return model.BotConfiguration{}, err
	}
	resolved, err := resolveBotDefaults(defaults, input.Overrides)
	if err != nil {
		return model.BotConfiguration{}, err
	}
	if resolved.Configuration == nil {
		return model.BotConfiguration{}, botConflict(fmt.Sprintf("Bot configuration is unavailable: %s. Read current defaults before submitting a new request.", *resolved.Reason))
	}
	return *resolved.Configuration, nil
}
