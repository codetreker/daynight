package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type botExpiryScope struct{ dao *botExpiryDAO }

func (s botExpiryScope) SessionDAO() store.SessionDAO { return s.dao }
func (s botExpiryScope) BotDAO() store.BotWriteDAO    { return s.dao }

type botExpiryDAO struct {
	store.SessionDAO
	store.BotWriteDAO
	t                   *testing.T
	mu                  sync.Mutex
	want, seen          []string
	principal           model.Principal
	bot                 model.Bot
	expired             bool
	credentialCalls     int
	firstCredentialTime time.Time
	blocked, release    chan struct{}
	registration        *store.SessionRegistration
	InsertCall          func(store.SessionRegistration) (bool, error)
	BindCall            func(string, int64, string, model.BotRoleConfiguration) (model.Bot, error)
	StartupCall         func(string, int64, model.BotStartupResult) (model.Bot, error)
	SessionCall         func(string) (store.SessionRecord, error)
	SessionsCall        func(string) ([]store.BotSession, error)
	RevokeCall          func(string) error
	DeletionCall        func(string, *model.BotDeletion) (model.Bot, error)
}

func (d *botExpiryDAO) call(name string) {
	d.mu.Lock()
	i := len(d.seen)
	d.seen = append(d.seen, name)
	ok := i < len(d.want) && d.want[i] == name
	d.mu.Unlock()
	if !ok {
		unexpectedHTTPCall(d.t, name)
	}
}

func (d *botExpiryDAO) check(ok bool, name string) {
	if !ok {
		unexpectedHTTPCall(d.t, "Bot expiry "+name+" arguments")
	}
}

func (d *botExpiryDAO) LockCredential(_ context.Context, principal model.Principal, now time.Time) error {
	d.call("LockCredential")
	d.check(principal == d.principal && !now.IsZero(), "LockCredential")
	d.credentialCalls++
	if d.credentialCalls == 1 {
		d.firstCredentialTime = now
	} else {
		d.check(!now.Before(d.firstCredentialTime), "credential recheck time")
		if d.expired {
			return model.ErrNotFound
		}
	}
	return nil
}

func (d *botExpiryDAO) Bot(ctx context.Context, id string) (model.Bot, error) {
	d.call("Bot")
	d.check(id == d.bot.ID && d.credentialCalls == 1, "Bot")
	if d.blocked != nil {
		close(d.blocked)
		select {
		case <-d.release:
		case <-ctx.Done():
			return model.Bot{}, ctx.Err()
		}
	}
	return botExpiryCloneBot(d.bot), nil
}

func (d *botExpiryDAO) InsertBotSession(_ context.Context, input store.SessionRegistration) (bool, error) {
	d.call("InsertBotSession")
	if d.InsertCall == nil {
		unexpectedHTTPCall(d.t, "InsertBotSession")
	}
	return d.InsertCall(input)
}

func (d *botExpiryDAO) BindBotSession(_ context.Context, id string, version int64, sessionID string, role model.BotRoleConfiguration) (model.Bot, error) {
	d.call("BindBotSession")
	if d.BindCall == nil {
		unexpectedHTTPCall(d.t, "BindBotSession")
	}
	value, err := d.BindCall(id, version, sessionID, role)
	return botExpiryCloneBot(value), err
}

func (d *botExpiryDAO) SetBotStartup(_ context.Context, id string, version int64, result model.BotStartupResult) (model.Bot, error) {
	d.call("SetBotStartup")
	if d.StartupCall == nil {
		unexpectedHTTPCall(d.t, "SetBotStartup")
	}
	value, err := d.StartupCall(id, version, result)
	return botExpiryCloneBot(value), err
}

func (d *botExpiryDAO) LockSession(_ context.Context, id string) (store.SessionRecord, error) {
	d.call("LockSession")
	if d.SessionCall == nil {
		unexpectedHTTPCall(d.t, "LockSession")
	}
	value, err := d.SessionCall(id)
	return botExpiryCloneRecord(value), err
}

func (d *botExpiryDAO) LockBotSessions(_ context.Context, id string) ([]store.BotSession, error) {
	d.call("LockBotSessions")
	if d.SessionsCall == nil {
		unexpectedHTTPCall(d.t, "LockBotSessions")
	}
	value, err := d.SessionsCall(id)
	return botExpiryCloneSlice(value), err
}

func (d *botExpiryDAO) RevokeBotSessions(_ context.Context, id string) error {
	d.call("RevokeBotSessions")
	if d.RevokeCall == nil {
		unexpectedHTTPCall(d.t, "RevokeBotSessions")
	}
	return d.RevokeCall(id)
}

func (d *botExpiryDAO) SaveBotDeletion(_ context.Context, id string, input *model.BotDeletion) (model.Bot, error) {
	d.call("SaveBotDeletion")
	if d.DeletionCall == nil {
		unexpectedHTTPCall(d.t, "SaveBotDeletion")
	}
	value, err := d.DeletionCall(id, input)
	return botExpiryCloneBot(value), err
}

func newBotExpiryPhase(t *testing.T, tx *httpTestStore, principal model.Principal, bot model.Bot, calls []string, outcome store.TransactionOutcome) *botExpiryDAO {
	t.Helper()
	d := &botExpiryDAO{t: t, principal: principal, bot: botExpiryCloneBot(bot), want: append([]string{"WriteSession"}, calls...)}
	original, err := json.Marshal(bot)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		d.mu.Lock()
		defer d.mu.Unlock()
		if !reflect.DeepEqual(d.seen, d.want) {
			t.Errorf("Bot operation calls = %v, want %v", d.seen, d.want)
		}
		actual, err := json.Marshal(d.bot)
		if err != nil || string(actual) != string(original) {
			t.Errorf("operation mutated supplied Bot facts: %v", err)
		}
	})
	tx.WriteSessionCall = func(ctx context.Context, operation func(store.SessionScope) error) (store.Completion, error) {
		d.call("WriteSession")
		err := operation(botExpiryScope{dao: d})
		if err != nil {
			return store.Completion{Outcome: outcome}, &store.TransactionError{Phase: "operation", Cause: err, Outcome: outcome}
		}
		return store.Completion{Outcome: outcome}, nil
	}
	return d
}

func blockedBotExpiryResponse(t *testing.T, ctx context.Context, cancel context.CancelFunc, dao *botExpiryDAO, request func() *httptest.ResponseRecorder) *httptest.ResponseRecorder {
	t.Helper()
	dao.blocked, dao.release = make(chan struct{}), make(chan struct{})
	result, finished := make(chan *httptest.ResponseRecorder, 1), make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(dao.release) }) }
	t.Cleanup(func() {
		release()
		cancel()
		select {
		case <-finished:
		case <-time.After(3 * time.Second):
			t.Error("Bot HTTP operation did not stop during cleanup")
		}
	})
	go func() {
		defer close(finished)
		result <- request()
	}()
	select {
	case <-dao.blocked:
	case <-finished:
		t.Fatal("Bot request completed before its admitted Bot observation")
	case <-ctx.Done():
		t.Fatal("Bot request did not reach its admitted Bot observation")
	}
	release()
	select {
	case response := <-result:
		return response
	case <-ctx.Done():
		t.Fatal("Bot request did not finish after its Bot observation")
		return nil
	}
}

func botExpiryClonePointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func botExpiryCloneSlice[T any](value []T) []T {
	if value == nil {
		return nil
	}
	cloned := make([]T, len(value))
	copy(cloned, value)
	return cloned
}

func botExpiryCloneBot(value model.Bot) model.Bot {
	value.RequestedOverrides.WorkerID = botExpiryClonePointer(value.RequestedOverrides.WorkerID)
	value.RequestedOverrides.Cwd = botExpiryClonePointer(value.RequestedOverrides.Cwd)
	value.RequestedOverrides.Provider = botExpiryClonePointer(value.RequestedOverrides.Provider)
	value.RequestedOverrides.Model = botExpiryClonePointer(value.RequestedOverrides.Model)
	value.RequestedOverrides.ReasoningEffort = botExpiryClonePointer(value.RequestedOverrides.ReasoningEffort)
	value.ResolvedConfiguration.Args = botExpiryCloneSlice(value.ResolvedConfiguration.Args)
	value.ResolvedConfiguration.Model = botExpiryClonePointer(value.ResolvedConfiguration.Model)
	value.ResolvedConfiguration.ReasoningEffort = botExpiryClonePointer(value.ResolvedConfiguration.ReasoningEffort)
	value.ResolvedConfiguration.Selection = botExpiryClonePointer(value.ResolvedConfiguration.Selection)
	value.RoleConfiguration = botExpiryClonePointer(value.RoleConfiguration)
	value.SessionID = botExpiryClonePointer(value.SessionID)
	value.TestExecutionID = botExpiryClonePointer(value.TestExecutionID)
	value.StartupResult.Code = botExpiryClonePointer(value.StartupResult.Code)
	value.Deletion = botExpiryClonePointer(value.Deletion)
	if value.Deletion != nil {
		value.Deletion.WorkerCleanup.Code = botExpiryClonePointer(value.Deletion.WorkerCleanup.Code)
		value.Deletion.ServerCleanup.Code = botExpiryClonePointer(value.Deletion.ServerCleanup.Code)
	}
	return value
}

func botExpiryCloneSnapshot(value sp.Snapshot) sp.Snapshot {
	value.Identity.NativeSessionID = botExpiryClonePointer(value.Identity.NativeSessionID)
	value.TurnStartedAt = botExpiryClonePointer(value.TurnStartedAt)
	value.CurrentTurnID = botExpiryClonePointer(value.CurrentTurnID)
	value.CleanupInteractionIDs = botExpiryCloneSlice(value.CleanupInteractionIDs)
	value.Controls = botExpiryClonePointer(value.Controls)
	if value.Controls != nil {
		value.Controls.SettingsError = botExpiryClonePointer(value.Controls.SettingsError)
		value.Controls.CommandsError = botExpiryClonePointer(value.Controls.CommandsError)
		value.Controls.Settings = botExpiryCloneSlice(value.Controls.Settings)
		for i := range value.Controls.Settings {
			setting := &value.Controls.Settings[i]
			setting.Description = botExpiryClonePointer(setting.Description)
			setting.Value = botExpiryClonePointer(setting.Value)
			setting.Options = botExpiryCloneSlice(setting.Options)
		}
		value.Controls.Commands = botExpiryCloneSlice(value.Controls.Commands)
		for i := range value.Controls.Commands {
			command := &value.Controls.Commands[i]
			command.ArgumentHint = botExpiryClonePointer(command.ArgumentHint)
		}
	}
	return value
}

func botExpiryCloneRegistration(value store.SessionRegistration) store.SessionRegistration {
	value.BotID = botExpiryClonePointer(value.BotID)
	value.Registration = botExpiryCloneSlice(value.Registration)
	value.Snapshot = botExpiryCloneSnapshot(value.Snapshot)
	return value
}

func botExpiryCloneRecord(value store.SessionRecord) store.SessionRecord {
	value.BotID = botExpiryClonePointer(value.BotID)
	value.ServerInstance = botExpiryClonePointer(value.ServerInstance)
	value.DrainTimelineSeq = botExpiryClonePointer(value.DrainTimelineSeq)
	value.SourceEpoch = botExpiryClonePointer(value.SourceEpoch)
	value.SourceEpochs = botExpiryCloneSlice(value.SourceEpochs)
	value.Registration = botExpiryCloneSlice(value.Registration)
	value.StopProof = botExpiryCloneSlice(value.StopProof)
	value.GrantHash = botExpiryCloneSlice(value.GrantHash)
	value.GrantExpiry = botExpiryClonePointer(value.GrantExpiry)
	value.ConnectionExpiry = botExpiryClonePointer(value.ConnectionExpiry)
	value.LastSeen = botExpiryClonePointer(value.LastSeen)
	value.DrainUntil = botExpiryClonePointer(value.DrainUntil)
	value.Snapshot = botExpiryCloneSnapshot(value.Snapshot)
	return value
}
