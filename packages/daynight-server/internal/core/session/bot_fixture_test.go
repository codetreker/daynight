package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type botFixtureDAO struct {
	store.BotWriteDAO
	t                                        *testing.T
	tracker                                  *fixtureDAO
	value                                    model.Bot
	registration                             *store.SessionRegistration
	archiveMetadata                          store.ArchiveMetadata
	bound, startup                           *model.Bot
	bindCalls, startupCalls, preferenceCalls int
	BotFn                                    func(context.Context, string) (model.Bot, error)
	BindFn                                   func(context.Context, string, int64, string, model.BotRoleConfiguration) (model.Bot, error)
	StartupFn                                func(context.Context, string, int64, model.BotStartupResult) (model.Bot, error)
	PreferenceFn                             func(context.Context, string) error
}

func (d *botFixtureDAO) Bot(ctx context.Context, id string) (model.Bot, error) {
	d.tracker.invoke(ctx, "Bot", d.BotFn != nil)
	return d.BotFn(ctx, id)
}
func (d *botFixtureDAO) BindBotSession(ctx context.Context, id string, version int64, session string, role model.BotRoleConfiguration) (model.Bot, error) {
	d.tracker.invoke(ctx, "BindBotSession", d.BindFn != nil)
	d.bindCalls++
	return d.BindFn(ctx, id, version, session, role)
}
func (d *botFixtureDAO) SetBotStartup(ctx context.Context, id string, version int64, result model.BotStartupResult) (model.Bot, error) {
	d.tracker.invoke(ctx, "SetBotStartup", d.StartupFn != nil)
	d.startupCalls++
	return d.StartupFn(ctx, id, version, result)
}
func (d *botFixtureDAO) CommitBotPreferences(ctx context.Context, id string) error {
	d.tracker.invoke(ctx, "CommitBotPreferences", d.PreferenceFn != nil)
	d.preferenceCalls++
	return d.PreferenceFn(ctx, id)
}
func botDAO(f fixture) *botFixtureDAO { return f.writer.bot.(*botFixtureDAO) }

func botPhase(t *testing.T, f fixture, ctx context.Context, counts map[string]int) context.Context {
	t.Helper()
	planned := f.dao.ContextPhase(ctx, counts)
	t.Cleanup(func() { f.dao.FinishContext(planned) })
	return planned
}

func botFixture(t *testing.T) (fixture, model.Bot, BotRegistration) {
	t.Helper()
	f := setup(t)
	configuration := model.BotConfiguration{WorkerID: f.r.WorkerID, Cwd: "/ordinary/directory", Provider: "codex", Args: []string{}}
	bot := model.Bot{ID: uuid.NewString(), OwnerUserID: f.p.UserID, WorkerID: f.r.WorkerID, Name: "Assistant", Version: 1, ResolvedConfiguration: configuration, StartupResult: model.BotStartupResult{State: "pending"}}
	digest := sha256.Sum256([]byte("Use Daynight CLI."))
	input := BotRegistration{BotVersion: bot.Version, Configuration: configuration, RoleConfiguration: model.BotRoleConfiguration{Instructions: "Use Daynight CLI.", Revision: "1", Digest: hex.EncodeToString(digest[:])}, Registration: sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}}
	d := &botFixtureDAO{t: t, tracker: f.dao, value: bot}
	d.BotFn = func(_ context.Context, id string) (model.Bot, error) {
		if id != bot.ID {
			return model.Bot{}, model.ErrNotFound
		}
		return d.value, nil
	}
	f.writer.bot = d
	f.data.Session = nil
	f.dao.InsertBotSessionFn = func(_ context.Context, registration store.SessionRegistration) (bool, error) {
		if registration.BotID == nil || *registration.BotID != bot.ID || registration.OwnerID != f.p.UserID || registration.ParentCredentialID != f.p.CredentialID || registration.Location.ProjectID != "" || registration.Location.TaskID != "" || registration.TestExecutionID != input.Registration.TestExecutionID {
			t.Fatalf("wrong proposed Bot Session: %+v", registration)
		}
		if d.registration != nil {
			t.Fatal("registration inserted another Session")
		}
		copy := registration
		d.registration = &copy
		f.writes.Registration = new(fixtureCopy(registration))
		return true, nil
	}
	d.BindFn = func(_ context.Context, id string, version int64, session string, role model.BotRoleConfiguration) (model.Bot, error) {
		if d.registration == nil || id != bot.ID || version != 1 || session != d.registration.Location.SessionID || role != input.RoleConfiguration {
			t.Fatal("binding did not use proposed Session and frozen role")
		}
		bound := d.value
		bound.Version = 2
		bound.SessionID, bound.TestExecutionID, bound.RoleConfiguration = &session, &input.Registration.TestExecutionID, &role
		d.bound = &bound
		return bound, nil
	}
	d.StartupFn = func(_ context.Context, id string, version int64, result model.BotStartupResult) (model.Bot, error) {
		if id != bot.ID || version != d.value.Version {
			t.Fatal("startup used different Bot/version")
		}
		updated := d.value
		updated.Version = version + 1
		updated.StartupResult = result
		d.startup = &updated
		return updated, nil
	}
	d.PreferenceFn = func(_ context.Context, id string) error {
		if id != bot.ID {
			t.Fatal("preferences used different Bot")
		}
		return nil
	}
	f.dao.ListTestSessionsFn = func(context.Context, string, time.Time, int, bool, time.Time, *time.Time, string) ([]store.TestSessionListItem, error) {
		return []store.TestSessionListItem{}, nil
	}
	f.dao.ArchiveMetadataFn = func(_ context.Context, id string) (store.ArchiveMetadata, error) {
		if f.data.Session == nil || id != f.data.Session.Snapshot.SessionID {
			return store.ArchiveMetadata{}, model.ErrNotFound
		}
		return d.archiveMetadata, nil
	}
	return f, bot, input
}

func registeredBot(t *testing.T) (fixture, BotRegistrationResult, BotRegistration) {
	t.Helper()
	f, bot, input := botFixture(t)
	out, err := f.s.RegisterBot(botPhase(t, f, t.Context(), map[string]int{"LockCredential": 2, "InsertBotSession": 1, "Bot": 1, "BindBotSession": 1}), f.p, bot.WorkerID, bot.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	selectBotBinding(t, f, out)
	botDAO(f).BindFn = nil
	return f, out, input
}
func connectedBotFixture(t *testing.T) (fixture, BotRegistrationResult, BotRegistration, GrantResult) {
	t.Helper()
	f, out, input := registeredBot(t)
	now := f.s.now()
	expiry := now.Add(time.Hour)
	epoch := uuid.NewString()
	v := out.Session
	v.ConnectionEpoch = "1"
	v.ConnectionState = "connected"
	v.Activity = "initializing"
	supplied := fixtureCopy(*f.data.Session)
	supplied.Snapshot = durableSnapshot(v)
	supplied.ServerInstance = &f.s.instance
	supplied.SourceEpoch, supplied.SourceEpochs = &epoch, []string{epoch}
	supplied.ConnectionExpiry, supplied.LastSeen = &expiry, &now
	supplied.ConnectionParent, supplied.Consumed, supplied.GrantKind = f.p.CredentialID, true, "bootstrap"
	f.data.Session = &supplied
	live := newLive(v)
	live.LastSeen = &now
	f.s.live[v.SessionID] = &liveCell{value: live}
	out.Session = v
	return f, out, input, GrantResult{}
}

func selectBotBinding(t *testing.T, f fixture, result BotRegistrationResult) {
	t.Helper()
	d := botDAO(f)
	if d.registration == nil || d.bound == nil || d.bindCalls != 1 || result.Bot.SessionID == nil || *result.Bot.SessionID != d.registration.Location.SessionID || result.Session.SessionID != d.registration.Location.SessionID || result.Bot.RoleConfiguration == nil || !jsonEqual(encode(result.Bot), encode(d.bound)) {
		t.Fatal("binding result did not match proposed Session/role")
	}
	f.SelectRegistrationWrite(t)
	d.value = fixtureCopy(result.Bot)
	d.archiveMetadata = store.ArchiveMetadata{Owner: f.p.UserID, Parent: f.p.CredentialID, Test: true, Backend: "web", BotValid: true}
}

func selectBotStartup(t *testing.T, f fixture, result model.Bot) {
	t.Helper()
	d := botDAO(f)
	if d.startup == nil || !jsonEqual(encode(result), encode(d.startup)) {
		t.Fatal("startup result differed from configured DAO result")
	}
	d.value = fixtureCopy(result)
}

func selectBotGrant(t *testing.T, f fixture, result GrantResult) {
	t.Helper()
	if f.writes.Grant == nil || result.Token == "" {
		t.Fatal("grant omitted the proposed credential")
	}
	hash := sha256.Sum256([]byte(result.Token))
	if !bytes.Equal(hash[:], f.writes.Grant.Hash) {
		t.Fatal("grant token did not match DAO hash")
	}
	f.SelectSessionWrite(t)
	f.SelectGrantWrite(t)
	if f.writes.StopProof != nil {
		f.data.Session.StopProof = bytes.Clone(f.writes.StopProof)
		f.writes.StopProof = nil
	}
}

func missingBotSession(t *testing.T, f fixture, id string) {
	t.Helper()
	f.data.Session = nil
	f.dao.SessionLocationFn = func(_ context.Context, actual string) (store.SessionLocation, error) {
		if actual != id {
			t.Fatal("missing Session lookup changed identity")
		}
		return store.SessionLocation{}, model.ErrNotFound
	}
}

func readyBotReport(out BotRegistrationResult) BotReport {
	fence := out.Session.ControllerFence
	return BotReport{BotVersion: out.Bot.Version, Fence: &fence, ControllerID: out.Session.Identity.ControllerID, ControllerInstanceID: out.Session.Identity.ControllerInstanceID, NativeSessionID: out.Session.Identity.NativeSessionID, Result: model.BotStartupResult{State: "ready"}}
}
