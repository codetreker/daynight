package bot

import (
	"context"
	"fmt"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type botStore interface {
	store.SnapshotReader
	store.BotWriter
}
type Bots struct{ store botStore }

func New(database botStore) *Bots { return &Bots{store: database} }

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
	var result model.Bot
	completion, err := s.store.WriteBot(ctx, func(scope store.BotScope) error {
		var err error
		result, err = botcore.Create(ctx, scope.BotDAO(), principal, input, fingerprint, resolve)
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
		result, err = botcore.Get(ctx, scope, principal, id)
		return err
	})
	if err != nil {
		return model.Bot{}, botcore.ResultError("get", err)
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
		var err error
		records, err = botcore.List(ctx, scope, principal, workerID, page)
		return err
	})
	if err != nil {
		return botcore.BotPage{}, botcore.ResultError("list", err)
	}
	return botcore.ListResult(principal, workerID, records)
}
func (s *Bots) Defaults(ctx context.Context, principal model.Principal, workerID *string) (botcore.BotDefaults, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return botcore.BotDefaults{}, err
	}
	if workerID != nil {
		id, err := model.CanonicalID(*workerID)
		if err != nil {
			return botcore.BotDefaults{}, err
		}
		workerID = &id
	}
	var result botcore.BotDefaults
	err := s.store.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		var err error
		result, err = botcore.Defaults(ctx, scope, principal, workerID)
		return err
	})
	if err != nil {
		return botcore.BotDefaults{}, botcore.ResultError("defaults", err)
	}
	return result, nil
}
