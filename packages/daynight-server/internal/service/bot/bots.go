package bot

import (
	"context"
	"errors"
	"fmt"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type botStore interface {
	store.SnapshotReader
	store.BotWriter
}
type Bots struct {
	store         botStore
	models        modelRequester
	operations    botOperations
	observer      sessionObserver
	authorization DefinitionAuthorizationSource
}

func New(database botStore) *Bots { return &Bots{store: database, operations: defaultBotOperations()} }

func (s *Bots) ScopeProtected() bool { return s != nil && s.authorization != nil }

// NewScoped installs current-policy admission without changing legacy assembly.
func NewScoped(database botStore, authorization DefinitionAuthorizationSource) (*Bots, error) {
	if authorization == nil {
		return nil, errors.New("definition authorization source is required")
	}
	s := New(database)
	s.authorization = authorization
	return s, nil
}

func (s *Bots) Create(ctx context.Context, principal model.Principal, input botcore.CreateBot) (model.Bot, error) {
	return s.create(ctx, principal, input, false)
}
func (s *Bots) CreateResolved(ctx context.Context, principal model.Principal, input botcore.CreateBot) (model.Bot, error) {
	return s.create(ctx, principal, input, true)
}
func (s *Bots) create(ctx context.Context, principal model.Principal, input botcore.CreateBot, resolve bool) (model.Bot, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.Bot{}, err
	}
	input, fingerprint, err := botcore.NormalizeBotRequest(input)
	if err != nil {
		return model.Bot{}, err
	}
	if s.authorization != nil {
		err = s.store.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
			_, err := s.operations.get(ctx, scope, principal, input.ID)
			if err != nil {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "not_found" {
					return err
				}
				if input.Overrides.WorkerID != nil {
					if err := botcore.RequireWorker(ctx, scope.BotDAO(), principal, *input.Overrides.WorkerID); err != nil {
						return err
					}
				}
			}
			return s.readAdmission(ctx, scope, principal, definitionProjection(ctx, scopepolicy.BotWrite, scopepolicy.BotRead, scopepolicy.SessionRead)...)
		})
		if err != nil {
			return model.Bot{}, definitionResultError("create", err)
		}
	}
	if resolve {
		input.Resolution, input.ResolutionError = s.prepareCreation(ctx, principal, input)
	}
	var result model.Bot
	completion, err := s.store.WriteBot(ctx, func(scope store.BotScope) error {
		if s.authorization != nil {
			authorization, authErr := s.authorization.BotWrite(ctx, scope, principal)
			var err error
			result, err = s.operations.createScoped(ctx, scope.BotDAO(), principal, input, fingerprint, resolve, func() error {
				return requireDefinition(principal, authorization, authErr, definitionProjection(ctx, scopepolicy.BotWrite, scopepolicy.BotRead, scopepolicy.SessionRead)...)
			})
			return err
		}
		var err error
		result, err = s.operations.create(ctx, scope.BotDAO(), principal, input, fingerprint, resolve)
		return err
	})
	if err != nil {
		return model.Bot{}, botcore.ResultError("create", err)
	}
	if completion.Outcome != store.TransactionCommitted {
		return model.Bot{}, botcore.ResultError("create", fmt.Errorf("transaction did not confirm commit"))
	}
	return result, nil
}
func (s *Bots) Get(ctx context.Context, principal model.Principal, id string) (model.Bot, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.Bot{}, err
	}
	id, err := model.CanonicalID(id)
	if err != nil {
		return model.Bot{}, err
	}
	var result model.Bot
	err = s.store.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		var err error
		result, err = s.operations.get(ctx, scope, principal, id)
		if err == nil {
			err = s.readAdmission(ctx, scope, principal, definitionProjection(ctx, scopepolicy.BotRead, scopepolicy.SessionRead)...)
		}
		return err
	})
	if err != nil {
		return model.Bot{}, definitionResultError("get", err)
	}
	return result, nil
}
func (s *Bots) List(ctx context.Context, principal model.Principal, request model.PageRequest) (botcore.BotPage, error) {
	return s.list(ctx, principal, nil, request)
}
func (s *Bots) ListWorker(ctx context.Context, principal model.Principal, workerID string, request model.PageRequest) (botcore.BotPage, error) {
	id, err := model.CanonicalID(workerID)
	if err != nil {
		return botcore.BotPage{}, err
	}
	return s.list(ctx, principal, &id, request)
}
func (s *Bots) list(ctx context.Context, principal model.Principal, workerID *string, request model.PageRequest) (botcore.BotPage, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return botcore.BotPage{}, err
	}
	page, err := botcore.ListPage(principal, workerID, request)
	if err != nil {
		return botcore.BotPage{}, err
	}
	var records store.BotPage
	err = s.store.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		if s.authorization != nil {
			var err error
			records, err = s.operations.listScoped(ctx, scope, principal, workerID, page, func() error {
				return s.readAdmission(ctx, scope, principal, definitionProjection(ctx, scopepolicy.BotRead, scopepolicy.SessionRead)...)
			})
			return err
		}
		var err error
		records, err = s.operations.list(ctx, scope, principal, workerID, page)
		return err
	})
	if err != nil {
		return botcore.BotPage{}, definitionResultError("list", err)
	}
	return botcore.ListResult(principal, workerID, records)
}
func (s *Bots) Defaults(ctx context.Context, principal model.Principal, workerID *string) (botcore.BotDefaults, error) {
	return s.DefaultsFor(ctx, principal, model.BotOverrides{WorkerID: workerID})
}
func (s *Bots) DefaultsFor(ctx context.Context, principal model.Principal, overrides model.BotOverrides) (botcore.BotDefaults, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return botcore.BotDefaults{}, err
	}
	if overrides.WorkerID != nil {
		id, err := model.CanonicalID(*overrides.WorkerID)
		if err != nil {
			return botcore.BotDefaults{}, err
		}
		overrides.WorkerID = &id
	}
	if err := botcore.NormalizeOverrides(overrides); err != nil {
		return botcore.BotDefaults{}, err
	}
	var defaults model.BotDefaultsInput
	err := s.store.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		if _, err := scope.CredentialDAO().Credential(ctx, principal); err != nil {
			if errors.Is(err, model.ErrNotFound) {
				return model.Unauthenticated(err)
			}
			return err
		}
		if s.authorization != nil && overrides.WorkerID != nil {
			if err := botcore.RequireWorker(ctx, scope.BotDAO(), principal, *overrides.WorkerID); err != nil {
				return err
			}
		}
		if err := s.readAdmission(ctx, scope, principal, scopepolicy.BotRead, scopepolicy.WorkerRead); err != nil {
			return err
		}
		var err error
		defaults, err = scope.BotDAO().BotDefaults(ctx, principal.UserID)
		return err
	})
	if err != nil {
		return botcore.BotDefaults{}, definitionResultError("defaults", err)
	}
	result, err := s.operations.defaults(defaults, overrides)
	if err != nil || result.Configuration == nil {
		return result, err
	}
	base := *result.Configuration
	preference := defaults.WorkerPreferences[base.WorkerID].Native[base.Provider]
	if botcore.RequiresNativeDiscovery(base, preference) {
		baseline, err := s.operations.workerDefaults(defaults, overrides, base.WorkerID)
		if err != nil {
			return botcore.BotDefaults{}, err
		}
		final, err := s.resolveNative(ctx, principal, base, overrides, preference, baseline, scopepolicy.BotRead, scopepolicy.WorkerRead, scopepolicy.WorkerInspect)
		if err != nil {
			return botcore.BotDefaults{}, err
		}
		result.Configuration = &final
		for index := range result.Workers {
			if result.Workers[index].WorkerID == base.WorkerID {
				result.Workers[index].Configuration = &final
			}
		}
	}
	return result, nil
}
