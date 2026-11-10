package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
)

type mcpBotOperations struct {
	t         *testing.T
	principal model.Principal
	mu        sync.Mutex
	create    func(context.Context, model.Principal, botcore.CreateBot) (model.Bot, error)
	list      func(context.Context, model.Principal, model.PageRequest) (botcore.BotPage, error)
	get       func(context.Context, model.Principal, string) (model.Bot, error)
	delete    func(context.Context, model.Principal, string, store.DeleteBot) (model.Bot, error)
	register  func(context.Context, model.Principal, string, string, sessioncore.BotRegistration) (sessioncore.BotRegistrationResult, error)
	complete  func(context.Context, model.Principal, string, string, botservice.BotDeletionReceipt) (model.Bot, error)
	snapshot  func(context.Context, model.Principal, string) (sp.Snapshot, error)
}

func (o *mcpBotOperations) unexpected(name string) error {
	o.t.Errorf("unconfigured or extra Bot.%s call", name)
	return errors.New("unconfigured Bot." + name)
}
func (o *mcpBotOperations) once(name string) func() {
	var mu sync.Mutex
	count := 0
	o.t.Cleanup(func() {
		mu.Lock()
		defer mu.Unlock()
		if count != 1 {
			o.t.Errorf("Bot.%s calls=%d, want 1", name, count)
		}
	})
	return func() {
		mu.Lock()
		defer mu.Unlock()
		count++
		if count != 1 {
			o.t.Errorf("extra Bot.%s call", name)
		}
	}
}
func (o *mcpBotOperations) check(ctx context.Context, p model.Principal, name string) {
	if ctx.Err() != nil || p != o.principal {
		o.t.Errorf("Bot.%s context/principal changed", name)
	}
}
func (o *mcpBotOperations) expectCreate(input botcore.CreateBot, out model.Bot) {
	expected := input
	expected.Overrides = botExpiryCloneBot(model.Bot{RequestedOverrides: input.Overrides}).RequestedOverrides
	result := botExpiryCloneBot(out)
	called := o.once("CreateResolved")
	o.mu.Lock()
	defer o.mu.Unlock()
	o.create = func(ctx context.Context, p model.Principal, got botcore.CreateBot) (model.Bot, error) {
		called()
		mcpOperationContext(o.t, ctx, p)
		o.check(ctx, p, "CreateResolved")
		if !reflect.DeepEqual(got, expected) {
			o.t.Errorf("Bot create=%#v, want %#v", got, expected)
		}
		return botExpiryCloneBot(result), nil
	}
}
func (o *mcpBotOperations) expectGet(id string, out model.Bot) {
	result := botExpiryCloneBot(out)
	called := o.once("Get")
	o.mu.Lock()
	defer o.mu.Unlock()
	o.get = func(ctx context.Context, p model.Principal, got string) (model.Bot, error) {
		called()
		mcpOperationContext(o.t, ctx, p)
		o.check(ctx, p, "Get")
		if got != id {
			o.t.Errorf("Bot ID=%s want %s", got, id)
		}
		return botExpiryCloneBot(result), nil
	}
}
func (o *mcpBotOperations) expectList(input model.PageRequest, out botcore.BotPage) {
	expected := input
	expected.Cursor = botExpiryClonePointer(input.Cursor)
	result := botcore.BotPage{Items: make([]model.Bot, len(out.Items)), NextCursor: botExpiryClonePointer(out.NextCursor)}
	for i := range out.Items {
		result.Items[i] = botExpiryCloneBot(out.Items[i])
	}
	called := o.once("List")
	o.mu.Lock()
	defer o.mu.Unlock()
	o.list = func(ctx context.Context, p model.Principal, got model.PageRequest) (botcore.BotPage, error) {
		called()
		mcpOperationContext(o.t, ctx, p)
		o.check(ctx, p, "List")
		if !reflect.DeepEqual(got, expected) {
			o.t.Errorf("Bot list=%#v want %#v", got, expected)
		}
		copy := botcore.BotPage{Items: make([]model.Bot, len(result.Items)), NextCursor: botExpiryClonePointer(result.NextCursor)}
		for i := range result.Items {
			copy.Items[i] = botExpiryCloneBot(result.Items[i])
		}
		return copy, nil
	}
}
func (o *mcpBotOperations) expectDelete(id string, input store.DeleteBot, out model.Bot, err error) {
	result := botExpiryCloneBot(out)
	called := o.once("DeleteBot")
	o.mu.Lock()
	defer o.mu.Unlock()
	o.delete = func(ctx context.Context, p model.Principal, gotID string, got store.DeleteBot) (model.Bot, error) {
		called()
		mcpOperationContext(o.t, ctx, p)
		o.check(ctx, p, "DeleteBot")
		if gotID != id || got != input {
			o.t.Errorf("Bot delete=%s/%#v want %s/%#v", gotID, got, id, input)
		}
		return botExpiryCloneBot(result), err
	}
}
func (o *mcpBotOperations) CreateResolved(ctx context.Context, p model.Principal, in botcore.CreateBot) (model.Bot, error) {
	o.mu.Lock()
	fn := o.create
	o.create = nil
	o.mu.Unlock()
	if fn == nil {
		return model.Bot{}, o.unexpected("CreateResolved")
	}
	return fn(ctx, p, in)
}
func (o *mcpBotOperations) Get(ctx context.Context, p model.Principal, id string) (model.Bot, error) {
	o.mu.Lock()
	fn := o.get
	o.get = nil
	o.mu.Unlock()
	if fn == nil {
		return model.Bot{}, o.unexpected("Get")
	}
	return fn(ctx, p, id)
}
func (o *mcpBotOperations) List(ctx context.Context, p model.Principal, in model.PageRequest) (botcore.BotPage, error) {
	o.mu.Lock()
	fn := o.list
	o.list = nil
	o.mu.Unlock()
	if fn == nil {
		return botcore.BotPage{}, o.unexpected("List")
	}
	return fn(ctx, p, in)
}
func (o *mcpBotOperations) DeleteBot(ctx context.Context, p model.Principal, id string, in store.DeleteBot) (model.Bot, error) {
	o.mu.Lock()
	fn := o.delete
	o.delete = nil
	o.mu.Unlock()
	if fn == nil {
		return model.Bot{}, o.unexpected("DeleteBot")
	}
	return fn(ctx, p, id, in)
}
func (o *mcpBotOperations) Defaults(context.Context, model.Principal, *string) (botcore.BotDefaults, error) {
	return botcore.BotDefaults{}, o.unexpected("Defaults")
}
func (o *mcpBotOperations) ListWorker(context.Context, model.Principal, string, model.PageRequest) (botcore.BotPage, error) {
	return botcore.BotPage{}, o.unexpected("ListWorker")
}
func (o *mcpBotOperations) RegisterBot(ctx context.Context, p model.Principal, worker, id string, in sessioncore.BotRegistration) (sessioncore.BotRegistrationResult, error) {
	o.mu.Lock()
	fn := o.register
	o.register = nil
	o.mu.Unlock()
	if fn == nil {
		return sessioncore.BotRegistrationResult{}, o.unexpected("RegisterBot")
	}
	return fn(ctx, p, worker, id, in)
}
func (o *mcpBotOperations) CompleteBotDeletion(ctx context.Context, p model.Principal, worker, id string, in botservice.BotDeletionReceipt) (model.Bot, error) {
	o.mu.Lock()
	fn := o.complete
	o.complete = nil
	o.mu.Unlock()
	if fn == nil {
		return model.Bot{}, o.unexpected("CompleteBotDeletion")
	}
	return fn(ctx, p, worker, id, in)
}
func (o *mcpBotOperations) TestSnapshot(ctx context.Context, p model.Principal, id string) (sp.Snapshot, error) {
	o.mu.Lock()
	fn := o.snapshot
	o.snapshot = nil
	o.mu.Unlock()
	if fn == nil {
		return sp.Snapshot{}, o.unexpected("TestSnapshot")
	}
	return fn(ctx, p, id)
}
func (o *mcpBotOperations) GrantBot(context.Context, model.Principal, string, string, sessioncore.BotGrant) (sessioncore.GrantResult, error) {
	return sessioncore.GrantResult{}, o.unexpected("GrantBot")
}
func (o *mcpBotOperations) ReportBot(context.Context, model.Principal, string, string, sessioncore.BotReport) (model.Bot, error) {
	return model.Bot{}, o.unexpected("ReportBot")
}
func mcpBotModel(owner, worker, id, name string, overrides model.BotOverrides, configuration model.BotConfiguration, now time.Time) model.Bot {
	raw, _ := json.Marshal(struct {
		Name      string             `json:"name"`
		Overrides model.BotOverrides `json:"overrides"`
	}{Name: name, Overrides: overrides})
	sum := sha256.Sum256(raw)
	return model.Bot{ID: id, OwnerUserID: owner, WorkerID: worker, Name: name, Version: 1, CreationOrder: 1, RequestFingerprint: hex.EncodeToString(sum[:]), RequestedOverrides: overrides, ResolvedConfiguration: configuration, StartupResult: model.BotStartupResult{State: "pending"}, CreatedAt: now, UpdatedAt: now}
}
