package session

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func botFault(t *testing.T, err error, code string) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code {
		t.Fatalf("wanted %s, got %v", code, err)
	}
}
func markBotDeleted(t *testing.T, f fixture, bot model.Bot) {
	t.Helper()
	d := botDAO(f)
	d.value.Deletion = &model.BotDeletion{DeletionID: uuid.NewString(), RequestedVersion: bot.Version, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
	d.archiveMetadata.BotValid = false
	d.BindFn, d.StartupFn, d.PreferenceFn = nil, nil, nil
}
func TestBotDeletedBindingRejectsEverySharedEntryWithStaleLiveState(t *testing.T) {
	f, out, input, _ := connectedBotFixture(t)
	ctx := context.Background()
	v := out.Session
	state := sp.State{InitialInputState: "not_required", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
	if _, err := f.s.Handle(botPhase(t, f, ctx, map[string]int{"SessionLocation": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 2, "UnreconciledSessionOperationCount": 1, "TouchSession": 1, "SaveSession": 1, "Bot": 1}), sp.ControllerMessage{Type: "sync_state", ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
		t.Fatal(err)
	}
	f.SelectSessionWrite(t)
	g := BotGrant{BotVersion: out.Bot.Version, Grant: sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, ExecutionGeneration: "1", Kind: "reconnect"}}
	grant, err := f.s.GrantBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 3, "LockSession": 1, "SetSessionGrant": 1, "SaveSession": 1, "Bot": 1}), f.p, out.Bot.WorkerID, out.Bot.ID, g)
	if err != nil {
		t.Fatal(err)
	}
	selectBotGrant(t, f, grant)
	doc := encode(sp.ArchiveDocument{Fence: v.Fence, SchemaVersion: 1, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, Provider: v.Identity.Provider, Entries: []sp.TimelineEntry{}, Resources: []sp.ArchiveResource{}})
	if _, err := sp.DecodeArchive(doc); err != nil {
		t.Fatal(err)
	}
	markBotDeleted(t, f, out.Bot)
	checks := map[string]func() error{
		"register": func() error {
			_, e := f.s.RegisterBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 1, "Bot": 1}), f.p, out.Bot.WorkerID, out.Bot.ID, input)
			return e
		},
		"grant": func() error {
			_, e := f.s.GrantBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 1, "Bot": 1}), f.p, out.Bot.WorkerID, out.Bot.ID, g)
			return e
		},
		"report": func() error {
			_, e := f.s.ReportBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 1, "Bot": 1}), f.p, out.Bot.WorkerID, out.Bot.ID, readyBotReport(out))
			return e
		},
		"snapshot": func() error {
			_, e := f.s.TestSnapshot(botPhase(t, f, ctx, map[string]int{"SessionBotID": 1, "Bot": 1}), f.p, v.SessionID)
			return e
		},
		"other service snapshot": func() error {
			_, e := New(f.writer).TestSnapshot(botPhase(t, f, ctx, map[string]int{"SessionBotID": 1, "Bot": 1}), f.p, v.SessionID)
			return e
		},
		"browser poll": func() error {
			_, _, _, e := f.s.BrowserPoll(botPhase(t, f, ctx, map[string]int{"SessionBotID": 1, "Bot": 1}), f.p, "", "", v.SessionID, "")
			return e
		},
		"timeline": func() error {
			_, e := f.s.Timeline(botPhase(t, f, ctx, map[string]int{"SessionBotID": 1, "Bot": 1}), f.p, "", "", v.SessionID, "tail", "", 10)
			return e
		},
		"resource": func() error {
			_, _, e := f.s.Resource(botPhase(t, f, ctx, map[string]int{"SessionBotID": 1, "Bot": 1}), f.p, "", "", v.SessionID, uuid.NewString())
			return e
		},
		"submit": func() error {
			_, e := f.s.Submit(botPhase(t, f, ctx, map[string]int{"SessionBotID": 1, "Bot": 1}), f.p, "", "", v.SessionID, sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "one", OperationID: uuid.NewString(), Kind: "refresh_controls"})
			return e
		},
		"operation": func() error {
			_, e := f.s.Operation(botPhase(t, f, ctx, map[string]int{"SessionBotID": 1, "Bot": 1}), f.p, "", "", v.SessionID, uuid.NewString())
			return e
		},
		"authenticate": func() error {
			return f.s.AuthenticateController(botPhase(t, f, ctx, map[string]int{"SessionLocationByGrant": 1, "SessionBotID": 1, "Bot": 1}), grant.Token)
		},
		"hello": func() error {
			_, e := f.s.Connect(botPhase(t, f, ctx, map[string]int{"SessionLocationByGrant": 1, "SessionBotID": 1, "Bot": 1}), grant.Token, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, Provider: v.Identity.Provider, SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}, uuid.NewString())
			return e
		},
		"poll": func() error {
			_, e := f.s.Poll(botPhase(t, f, ctx, map[string]int{"SessionLocation": 1, "SessionBotID": 1, "Bot": 1}), v.ControllerFence)
			return e
		},
		"source ack": func() error {
			_, e := f.s.SourceSeq(botPhase(t, f, ctx, map[string]int{"SessionLocation": 1, "SessionBotID": 1, "Bot": 1}), v.ControllerFence)
			return e
		},
		"archive status": func() error {
			_, e := f.s.ArchiveStatus(botPhase(t, f, ctx, map[string]int{"SessionBotID": 1, "Bot": 1}), f.p, "", "", v.SessionID)
			return e
		},
		"archive update": func() error {
			_, e := f.s.UpdateArchive(botPhase(t, f, ctx, map[string]int{"SessionBotID": 1, "Bot": 1}), f.p, "", "", v.SessionID, sp.ArchiveUpdate{Fence: v.Fence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, State: "pending"})
			return e
		},
		"archive put": func() error {
			_, e := f.s.PutArchive(botPhase(t, f, ctx, map[string]int{"ReadCredential": 1, "ArchiveMetadata": 1}), f.p, "", "", v.SessionID, doc)
			return e
		},
		"archive content": func() error {
			_, e := f.s.ArchiveContent(botPhase(t, f, ctx, map[string]int{"ReadCredential": 1, "ArchiveMetadata": 1}), f.p, "", "", v.SessionID)
			return e
		},
	}
	for name, check := range checks {
		t.Run(name, func(t *testing.T) { botFault(t, check(), "resource_conflict") })
	}
	for _, kind := range []string{"heartbeat", "events", "content_response", "operation_begin", "operation_receipt", "reconcile", "sync_state", "source_reset"} {
		t.Run(kind, func(t *testing.T) {
			_, err := f.s.Handle(botPhase(t, f, ctx, map[string]int{"SessionLocation": 1, "SessionBotID": 1, "Bot": 1}), sp.ControllerMessage{Type: kind, ControllerFence: v.ControllerFence})
			botFault(t, err, "resource_conflict")
		})
	}
	if _, err := f.s.RegisterTest(botPhase(t, f, ctx, map[string]int{"LockCredential": 1, "LockTestOwner": 1, "FindTestRegistration": 1}), f.p, input.Registration); err == nil {
		t.Fatal("ordinary registration revived deleted Bot")
	}
	if _, err := f.s.Grant(botPhase(t, f, ctx, map[string]int{"SessionBotID": 1, "Bot": 1}), f.p, "", "", v.SessionID, g.Grant); err == nil {
		t.Fatal("ordinary grant revived deleted Bot")
	}
	if _, err := f.s.StopTest(botPhase(t, f, ctx, map[string]int{"SessionBotID": 1, "Bot": 1}), f.p, v.SessionID, sp.TestStop{}); err == nil {
		t.Fatal("ordinary stop changed deleted Bot")
	}
}

func TestBotRegistrationRejectsInvalidRoleAndProtocolBeforeRunner(t *testing.T) {
	for name, mutate := range map[string]func(*BotRegistration){
		"version":       func(v *BotRegistration) { v.BotVersion = 0 },
		"empty role":    func(v *BotRegistration) { v.RoleConfiguration.Instructions = "" },
		"unicode role":  func(v *BotRegistration) { v.RoleConfiguration.Instructions = string([]byte{0xff}) },
		"role size":     func(v *BotRegistration) { v.RoleConfiguration.Instructions = strings.Repeat("a", 65537) },
		"digest":        func(v *BotRegistration) { v.RoleConfiguration.Digest = strings.Repeat("a", 64) },
		"revision":      func(v *BotRegistration) { v.RoleConfiguration.Revision = "" },
		"initial input": func(v *BotRegistration) { v.Registration.InitialInput = "prompt" },
		"protocol":      func(v *BotRegistration) { v.Registration.Protocol = "invalid" },
	} {
		t.Run(name, func(t *testing.T) {
			execution, principal, bot, input := botRegistrationValidationFixture()
			mutate(&input)
			_, err := execution.RegisterBot(t.Context(), principal, bot.WorkerID, bot.ID, input)
			botFault(t, err, "invalid_input")
		})
	}
}

func TestBotRegistrationRejectsInvalidRoleAndFrozenConfiguration(t *testing.T) {
	f, bot, original := botFixture(t)
	ctx := context.Background()
	invalid := original
	invalid.Configuration.Cwd = ""
	_, err := f.s.RegisterBot(botPhase(t, f, ctx, map[string]int{}), f.p, bot.WorkerID, bot.ID, invalid)
	botFault(t, err, "invalid_input")
	assertBotRegistrationUnbound(t, f, bot)
	changed := original
	changed.Configuration.Cwd = "/changed"
	_, err = f.s.RegisterBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 1, "Bot": 1}), f.p, bot.WorkerID, bot.ID, changed)
	botFault(t, err, "session_conflict")
	changed = original
	changed.Registration.Provider = "claude"
	_, err = f.s.RegisterBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 1, "Bot": 1}), f.p, bot.WorkerID, bot.ID, changed)
	botFault(t, err, "session_conflict")
	changed = original
	changed.BotVersion = 2
	_, err = f.s.RegisterBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 1, "Bot": 1}), f.p, bot.WorkerID, bot.ID, changed)
	botFault(t, err, "version_conflict")
	_, err = f.s.RegisterBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 1, "Bot": 1}), f.p, uuid.NewString(), bot.ID, original)
	botFault(t, err, "forbidden")
	_, err = f.s.RegisterBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 1, "Bot": 1}), f.p, bot.WorkerID, uuid.NewString(), original)
	botFault(t, err, "not_found")
	other := addMember(t, f, "admin")
	_, err = f.s.RegisterBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 1, "Bot": 1}), other, bot.WorkerID, bot.ID, original)
	botFault(t, err, "forbidden")
	login := f.p
	login.Kind = model.SessionCredential
	_, err = f.s.RegisterBot(botPhase(t, f, ctx, map[string]int{}), login, bot.WorkerID, bot.ID, original)
	botFault(t, err, "forbidden")
	f.dao.LockCredentialFn = func(context.Context, model.Principal, time.Time) error {
		return fault("unauthenticated", "Credential expired.")
	}
	_, err = f.s.RegisterBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 1}), f.p, bot.WorkerID, bot.ID, original)
	botFault(t, err, "unauthenticated")
}

func TestBotParentRevocationAndBrowserIdentityAreRechecked(t *testing.T) {
	f, out, _, _ := connectedBotFixture(t)
	ctx := context.Background()
	v := out.Session
	other := addMember(t, f, "admin")
	_, err := f.s.TestSnapshot(botPhase(t, f, ctx, map[string]int{"SessionBotID": 1, "LockSession": 1, "LockCredential": 1, "Bot": 1}), other, v.SessionID)
	botFault(t, err, "forbidden")
	fresh := f.p
	fresh.CredentialID = uuid.NewString()
	f.dao.LockCredentialFn = func(_ context.Context, p model.Principal, _ time.Time) error {
		if p == f.p {
			return fault("unauthenticated", "Parent credential revoked.")
		}
		if p != fresh {
			t.Fatal("unexpected replacement principal")
		}
		return nil
	}
	_, err = f.s.TestSnapshot(botPhase(t, f, ctx, map[string]int{"SessionBotID": 1, "LockSession": 1, "LockCredential": 2, "Bot": 1}), fresh, v.SessionID)
	botFault(t, err, "unauthenticated")
	_, err = f.s.Poll(botPhase(t, f, ctx, map[string]int{"SessionLocation": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 1, "Bot": 1}), v.ControllerFence)
	botFault(t, err, "unauthenticated")
	_, err = f.s.ReportBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 3, "LockSession": 1, "Bot": 1}), fresh, out.Bot.WorkerID, out.Bot.ID, readyBotReport(out))
	botFault(t, err, "unauthenticated")
	g := BotGrant{BotVersion: out.Bot.Version, Grant: sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, ExecutionGeneration: "1", Kind: "reconnect"}}
	_, err = f.s.GrantBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 3, "LockSession": 1, "Bot": 1}), fresh, out.Bot.WorkerID, out.Bot.ID, g)
	botFault(t, err, "unauthenticated")
}

func TestBotReportRechecksReadinessEvenWhenTheStoredResultMatches(t *testing.T) {
	f, out, _, _ := connectedBotFixture(t)
	ctx := context.Background()
	v := out.Session
	state := sp.State{InitialInputState: "not_required", Synchronized: true, Activity: "idle"}
	if _, err := f.s.Handle(botPhase(t, f, ctx, map[string]int{"SessionLocation": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 2, "UnreconciledSessionOperationCount": 1, "TouchSession": 1, "SaveSession": 1, "Bot": 1}), sp.ControllerMessage{Type: "sync_state", ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
		t.Fatal(err)
	}
	f.SelectSessionWrite(t)
	report := readyBotReport(out)
	ready, err := f.s.ReportBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 4, "LockSession": 1, "Bot": 1, "SetBotStartup": 1, "CommitBotPreferences": 1}), f.p, out.Bot.WorkerID, out.Bot.ID, report)
	if err != nil {
		t.Fatal(err)
	}
	selectBotStartup(t, f, ready)
	report.BotVersion = ready.Version
	same, err := f.s.ReportBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 4, "LockSession": 1, "Bot": 1}), f.p, out.Bot.WorkerID, out.Bot.ID, report)
	if err != nil || same.Version != ready.Version {
		t.Fatal("no-op report advanced version", err)
	}
	f.s.now = func() time.Time { return time.Now().Add(HeartbeatTimeout + time.Second) }
	_, err = f.s.ReportBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 3, "LockSession": 1, "Bot": 1}), f.p, out.Bot.WorkerID, out.Bot.ID, report)
	botFault(t, err, "controller_offline")
}

func TestOrdinaryRegistrationRejectsBotBeforeTakingItsLock(t *testing.T) {
	f, _, input := registeredBot(t)
	botDAO(f).BotFn = func(context.Context, string) (model.Bot, error) {
		t.Fatal("ordinary registration acquired a Bot")
		return model.Bot{}, nil
	}
	_, err := f.s.RegisterTest(botPhase(t, f, t.Context(), map[string]int{"LockCredential": 1, "LockTestOwner": 1, "FindTestRegistration": 1}), f.p, input.Registration)
	botFault(t, err, "forbidden")
}

func TestBotDeletionObservationPrecedesWaitingBrowserAndControllerAdmission(t *testing.T) {
	for _, path := range []string{"browser", "controller"} {
		t.Run(path, func(t *testing.T) {
			f, out, _, _ := connectedBotFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			entered, release := make(chan struct{}), make(chan struct{})
			botDAO(f).BotFn = func(ctx context.Context, id string) (model.Bot, error) {
				if id != out.Bot.ID {
					t.Error("wrong Bot lock")
				}
				close(entered)
				select {
				case <-release:
					return botDAO(f).value, nil
				case <-ctx.Done():
					return model.Bot{}, ctx.Err()
				}
			}
			result := make(chan error, 1)
			go func() {
				if path == "browser" {
					_, err := f.s.TestSnapshot(botPhase(t, f, ctx, map[string]int{"SessionBotID": 1, "Bot": 1}), f.p, out.Session.SessionID)
					result <- err
				} else {
					_, err := f.s.Handle(botPhase(t, f, ctx, map[string]int{"SessionLocation": 1, "SessionBotID": 1, "Bot": 1}), sp.ControllerMessage{Type: "heartbeat", ControllerFence: out.Session.ControllerFence})
					result <- err
				}
			}()
			select {
			case <-entered:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			markBotDeleted(t, f, out.Bot)
			close(release)
			select {
			case err := <-result:
				botFault(t, err, "resource_conflict")
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		})
	}
}

func TestBotReadyReportRequiresCurrentConnectionCredentialAfterGrantReplacement(t *testing.T) {
	for _, invalidation := range []string{"revoked", "expired"} {
		for _, alreadyReady := range []bool{false, true} {
			name := "pending"
			if alreadyReady {
				name = "already ready"
			}
			t.Run(invalidation+"/"+name, func(t *testing.T) {
				f, out, _, _ := connectedBotFixture(t)
				ctx := context.Background()
				v := out.Session
				state := sp.State{InitialInputState: "not_required", Synchronized: true, Activity: "idle"}
				if _, err := f.s.Handle(botPhase(t, f, ctx, map[string]int{"SessionLocation": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 2, "UnreconciledSessionOperationCount": 1, "TouchSession": 1, "SaveSession": 1, "Bot": 1}), sp.ControllerMessage{Type: "sync_state", ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
					t.Fatal(err)
				}
				f.SelectSessionWrite(t)
				if alreadyReady {
					ready, err := f.s.ReportBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 4, "LockSession": 1, "Bot": 1, "SetBotStartup": 1, "CommitBotPreferences": 1}), f.p, out.Bot.WorkerID, out.Bot.ID, readyBotReport(out))
					if err != nil {
						t.Fatal(err)
					}
					selectBotStartup(t, f, ready)
					out.Bot = ready
				}
				replacement := f.p
				replacement.CredentialID = uuid.NewString()
				f.dao.LockCredentialFn = func(_ context.Context, p model.Principal, _ time.Time) error {
					if p != f.p && p != replacement {
						t.Fatal("unexpected grant principal")
					}
					return nil
				}
				grant, err := f.s.GrantBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 3, "LockSession": 1, "SetSessionGrant": 1, "SaveSession": 1, "Bot": 1}), replacement, out.Bot.WorkerID, out.Bot.ID, BotGrant{BotVersion: out.Bot.Version, Grant: sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, ExecutionGeneration: v.ExecutionGeneration, Kind: "reconnect"}})
				if err != nil {
					t.Fatal(err)
				}
				selection := f
				selection.p = replacement
				selectBotGrant(t, selection, grant)
				f.dao.LockCredentialFn = func(_ context.Context, p model.Principal, _ time.Time) error {
					if p == f.p {
						return fault("unauthenticated", "Connection credential "+invalidation+".")
					}
					if p != replacement {
						t.Fatal("unexpected replacement principal")
					}
					return nil
				}
				beforeStartup, beforePreferences := botDAO(f).startupCalls, botDAO(f).preferenceCalls
				result, err := f.s.ReportBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 4, "LockSession": 1, "Bot": 1}), replacement, out.Bot.WorkerID, out.Bot.ID, readyBotReport(out))
				if err == nil {
					t.Fatalf("replacement grant accepted synchronization from a revoked connection: startup=%s version=%d", result.StartupResult.State, result.Version)
				}
				botFault(t, err, "unauthenticated")
				if botDAO(f).startupCalls != beforeStartup || botDAO(f).preferenceCalls != beforePreferences {
					t.Fatal("refused readiness proposed startup or successful preferences")
				}

				// A replacement PAT grants readiness only after its own connection consumes
				// the grant and publishes a new synchronization observation.
				sourceEpoch := *f.data.Session.SourceEpoch
				out.Session, err = f.s.Connect(botPhase(t, f, ctx, map[string]int{"SessionLocationByGrant": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 2, "ConnectSession": 1, "SaveSession": 1, "Bot": 1}), grant.Token, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, Provider: v.Identity.Provider, SourceEpoch: sourceEpoch, LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}, uuid.NewString())
				if err != nil {
					t.Fatal(err)
				}
				f.SelectConnectionWrite(t)
				if _, err = f.s.Handle(botPhase(t, f, ctx, map[string]int{"SessionLocation": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 2, "UnreconciledSessionOperationCount": 1, "TouchSession": 1, "SaveSession": 1, "Bot": 1}), sp.ControllerMessage{Type: "sync_state", ControllerFence: out.Session.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
					t.Fatal(err)
				}
				f.SelectSessionWrite(t)
				counts := map[string]int{"LockCredential": 4, "LockSession": 1, "Bot": 1}
				if !alreadyReady {
					counts["SetBotStartup"], counts["CommitBotPreferences"] = 1, 1
				}
				result, err = f.s.ReportBot(botPhase(t, f, ctx, counts), replacement, out.Bot.WorkerID, out.Bot.ID, readyBotReport(out))
				if err != nil || result.StartupResult.State != "ready" {
					t.Fatalf("replacement connection's synchronization was rejected: %+v %v", result, err)
				}
			})
		}
	}
}
