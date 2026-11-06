package bot

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	"github.com/google/uuid"
)

type modelRequester interface {
	Request(context.Context, model.Principal, string, ro.Request) (ro.Message, error)
}

// NewWithNativeDiscovery shares the authenticated Worker broker with creation.
func NewWithNativeDiscovery(database botStore, requester modelRequester) *Bots {
	return &Bots{store: database, models: requester}
}

func (s *Bots) prepareCreation(ctx context.Context, principal model.Principal, input botcore.CreateBot) (*botcore.CreationResolution, error) {
	var defaults model.BotDefaultsInput
	existing := false
	err := s.store.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		_, err := botcore.Get(ctx, scope, principal, input.ID)
		if err == nil {
			existing = true
			return nil
		}
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "not_found" {
			return err
		}
		defaults, err = scope.BotDAO().BotDefaults(ctx, principal.UserID)
		return err
	})
	if err != nil {
		return nil, err
	}
	if existing {
		return nil, nil
	}
	resolved, err := botcore.ResolveBotDefaults(defaults, input.Overrides)
	if err != nil {
		return nil, err
	}
	if resolved.Configuration == nil {
		return nil, nil
	}
	base := *resolved.Configuration
	preference := defaults.WorkerPreferences[base.WorkerID].Native[base.Provider]
	if !botcore.RequiresNativeDiscovery(base, preference) {
		return nil, nil
	}
	baseline, err := botcore.WorkerNativeDefaults(defaults, input.Overrides, base.WorkerID)
	if err != nil {
		return nil, err
	}
	final, err := s.resolveNative(ctx, principal, base, input.Overrides, preference, baseline)
	if err != nil {
		return nil, err
	}
	return &botcore.CreationResolution{Expected: base, ExpectedBaseline: baseline, ExpectedPreference: preference, Configuration: final}, nil
}

func (s *Bots) readModels(ctx context.Context, principal model.Principal, base model.BotConfiguration, selected *string) (ro.ModelResult, error) {
	if s.models == nil {
		return ro.ModelResult{}, nativeFailure("unsupported_native_selection", "Worker native selection discovery is unavailable.")
	}
	hidden, limit := true, 100
	input := ro.ModelInput{Provider: base.Provider, Cwd: &base.Cwd, Model: selected, IncludeHidden: &hidden, Limit: &limit}
	var catalog ro.ModelResult
	var fence ro.Fence
	seen := map[string]bool{}
	for page := 0; page < 500; page++ {
		raw, err := json.Marshal(input)
		if err != nil {
			return catalog, err
		}
		requestID := uuid.NewString()
		response, err := s.models.Request(ctx, principal, base.WorkerID, ro.Request{RequestID: requestID, Operation: "model.list", Input: raw})
		if err != nil {
			return catalog, err
		}
		if response.OwnerUserID != principal.UserID || response.WorkerID != base.WorkerID || response.RequestID != requestID {
			return catalog, nativeFailure("stale_configuration", "Worker model response belongs to a different request.")
		}
		if response.Error != nil {
			return catalog, nativeFailure(response.Error.Code, response.Error.Message)
		}
		if err := ro.ValidateOperationResult(response, "model.list"); err != nil {
			return catalog, err
		}
		var next ro.ModelResult
		if err := json.Unmarshal(response.Result, &next); err != nil {
			return catalog, err
		}
		if next.Provider != base.Provider {
			return catalog, nativeFailure("stale_configuration", "Worker model response belongs to a different Provider.")
		}
		if page == 0 {
			fence = response.Fence
			catalog = next
		} else {
			if response.Fence != fence || next.ConfigurationGeneration != catalog.ConfigurationGeneration || next.CatalogGeneration != catalog.CatalogGeneration || next.Cwd != catalog.Cwd || !reflect.DeepEqual(next.Defaults, catalog.Defaults) || !reflect.DeepEqual(next.SelectionError, catalog.SelectionError) {
				return catalog, nativeFailure("stale_configuration", "Worker model catalog changed during pagination.")
			}
			catalog.Models = append(catalog.Models, next.Models...)
			catalog.NextCursor = next.NextCursor
		}
		if len(catalog.Models) > 500 {
			return catalog, nativeFailure("limit_exceeded", "Worker model catalog exceeds its bounded size.")
		}
		if next.NextCursor == nil {
			return catalog, nil
		}
		if seen[*next.NextCursor] {
			return catalog, nativeFailure("invalid_cursor", "Worker repeated a model catalog cursor.")
		}
		seen[*next.NextCursor] = true
		input.Cursor = next.NextCursor
	}
	return catalog, nativeFailure("limit_exceeded", "Worker model catalog exceeds its page limit.")
}
func nativeFailure(code, message string) error { return &model.Fault{Code: code, Message: message} }

func (s *Bots) resolveNative(ctx context.Context, principal model.Principal, base model.BotConfiguration, overrides model.BotOverrides, preference model.BotNativePreference, baseline model.BotConfiguration) (model.BotConfiguration, error) {
	ctx, cancel := context.WithTimeout(ctx, ro.ModelRequestTimeout)
	defer cancel()
	selected := base.Model
	// Omission preserves Worker/native default discovery; a preference or an
	// explicit model is the only reason to request a model-specific catalog.
	if base.Selection.ModelSource != "explicit" && base.Selection.ModelSource != "preference" {
		selected = nil
	}
	// A stored preference may have disappeared before native initialization. Read
	// the default catalog first so a retired preference never becomes probe input.
	probeModel := selected
	if base.Selection.ModelSource == "preference" {
		probeModel = nil
	}
	catalog, err := s.readModels(ctx, principal, base, probeModel)
	if err != nil {
		return base, err
	}
	if base.Selection.ModelSource == "preference" {
		if botcore.NativeModel(catalog, selected) == nil {
			selected = nil
		} else {
			catalog, err = s.readModels(ctx, principal, base, selected)
			if err != nil {
				return base, err
			}
		}
	}
	if botcore.NativeDelegationFallback(baseline, overrides, catalog, selected) {
		return baseline, nil
	}
	return botcore.ResolveNativeSelection(base, overrides, preference, catalog, selected)
}
