package sessionrelay

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
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
	if _, err := f.s.DB.Pool.Exec(context.Background(), `UPDATE bots SET deletion=$2,version=version+1 WHERE id=$1`, bot.ID, encode(model.BotDeletion{DeletionID: uuid.NewString(), RequestedVersion: bot.Version, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}})); err != nil {
		t.Fatal(err)
	}
}
func TestBotDeletedBindingRejectsEverySharedEntryWithStaleLiveState(t *testing.T) {
	f, out, input, _ := connectBot(t)
	ctx := context.Background()
	v := out.Session
	state := sp.State{InitialInputState: "not_required", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
	if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "sync_state", ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
		t.Fatal(err)
	}
	g := BotGrant{BotVersion: out.Bot.Version, Grant: sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, ExecutionGeneration: "1", Kind: "reconnect"}}
	grant, err := f.s.GrantBot(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, g)
	if err != nil {
		t.Fatal(err)
	}
	doc := encode(sp.ArchiveDocument{Fence: v.Fence, SchemaVersion: 1, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, Provider: v.Identity.Provider, Entries: []sp.TimelineEntry{}, Resources: []sp.ArchiveResource{}})
	if _, err := sp.DecodeArchive(doc); err != nil {
		t.Fatal(err)
	}
	markBotDeleted(t, f, out.Bot)
	checks := map[string]func() error{
		"register": func() error { _, e := f.s.RegisterBot(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, input); return e },
		"grant":    func() error { _, e := f.s.GrantBot(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, g); return e },
		"report": func() error {
			_, e := f.s.ReportBot(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, readyBotReport(out))
			return e
		},
		"snapshot":               func() error { _, e := f.s.TestSnapshot(ctx, f.p, v.SessionID); return e },
		"other service snapshot": func() error { _, e := New(f.s.DB).TestSnapshot(ctx, f.p, v.SessionID); return e },
		"browser poll":           func() error { _, _, _, e := f.s.BrowserPoll(ctx, f.p, "", "", v.SessionID, ""); return e },
		"timeline":               func() error { _, e := f.s.Timeline(ctx, f.p, "", "", v.SessionID, "tail", "", 10); return e },
		"resource":               func() error { _, _, e := f.s.Resource(ctx, f.p, "", "", v.SessionID, uuid.NewString()); return e },
		"submit": func() error {
			_, e := f.s.Submit(ctx, f.p, "", "", v.SessionID, sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "one", OperationID: uuid.NewString(), Kind: "refresh_controls"})
			return e
		},
		"operation":    func() error { _, e := f.s.Operation(ctx, f.p, "", "", v.SessionID, uuid.NewString()); return e },
		"authenticate": func() error { return f.s.AuthenticateController(ctx, grant.Token) },
		"hello": func() error {
			_, e := f.s.Connect(ctx, grant.Token, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, Provider: v.Identity.Provider, SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}, uuid.NewString())
			return e
		},
		"poll":           func() error { _, e := f.s.Poll(ctx, v.ControllerFence); return e },
		"source ack":     func() error { _, e := f.s.SourceSeq(ctx, v.ControllerFence); return e },
		"archive status": func() error { _, e := f.s.ArchiveStatus(ctx, f.p, "", "", v.SessionID); return e },
		"archive update": func() error {
			_, e := f.s.UpdateArchive(ctx, f.p, "", "", v.SessionID, sp.ArchiveUpdate{Fence: v.Fence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, State: "pending"})
			return e
		},
		"archive put":     func() error { _, e := f.s.PutArchive(ctx, f.p, "", "", v.SessionID, doc); return e },
		"archive content": func() error { _, e := f.s.ArchiveContent(ctx, f.p, "", "", v.SessionID); return e },
	}
	for name, check := range checks {
		t.Run(name, func(t *testing.T) { botFault(t, check(), "resource_conflict") })
	}
	for _, kind := range []string{"heartbeat", "events", "content_response", "operation_begin", "operation_receipt", "reconcile", "sync_state", "source_reset"} {
		t.Run(kind, func(t *testing.T) {
			_, err := f.s.Handle(ctx, sp.ControllerMessage{Type: kind, ControllerFence: v.ControllerFence})
			botFault(t, err, "resource_conflict")
		})
	}
	if _, err := f.s.RegisterTest(ctx, f.p, input.Registration); err == nil {
		t.Fatal("ordinary registration revived deleted Bot")
	}
	if _, err := f.s.Grant(ctx, f.p, "", "", v.SessionID, g.Grant); err == nil {
		t.Fatal("ordinary grant revived deleted Bot")
	}
	if _, err := f.s.StopTest(ctx, f.p, v.SessionID, sp.TestStop{}); err == nil {
		t.Fatal("ordinary stop changed deleted Bot")
	}
}

func TestBotRegistrationRejectsInvalidRoleAndFrozenConfiguration(t *testing.T) {
	f, bot, original := botFixture(t)
	ctx := context.Background()
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
			input := original
			mutate(&input)
			_, err := f.s.RegisterBot(ctx, f.p, bot.WorkerID, bot.ID, input)
			botFault(t, err, "invalid_input")
		})
	}
	changed := original
	changed.Configuration.Cwd = "/changed"
	_, err := f.s.RegisterBot(ctx, f.p, bot.WorkerID, bot.ID, changed)
	botFault(t, err, "session_conflict")
	changed = original
	changed.Registration.Provider = "claude"
	_, err = f.s.RegisterBot(ctx, f.p, bot.WorkerID, bot.ID, changed)
	botFault(t, err, "session_conflict")
	changed = original
	changed.BotVersion = 2
	_, err = f.s.RegisterBot(ctx, f.p, bot.WorkerID, bot.ID, changed)
	botFault(t, err, "version_conflict")
	_, err = f.s.RegisterBot(ctx, f.p, uuid.NewString(), bot.ID, original)
	botFault(t, err, "forbidden")
	_, err = f.s.RegisterBot(ctx, f.p, bot.WorkerID, uuid.NewString(), original)
	botFault(t, err, "not_found")
	other := addMember(t, f, "admin")
	_, err = f.s.RegisterBot(ctx, other, bot.WorkerID, bot.ID, original)
	botFault(t, err, "forbidden")
	login := f.p
	login.Kind = model.SessionCredential
	_, err = f.s.RegisterBot(ctx, login, bot.WorkerID, bot.ID, original)
	botFault(t, err, "forbidden")
	if _, err = f.s.DB.Pool.Exec(ctx, `UPDATE personal_access_tokens SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE id=$1`, f.p.CredentialID); err != nil {
		t.Fatal(err)
	}
	_, err = f.s.RegisterBot(ctx, f.p, bot.WorkerID, bot.ID, original)
	botFault(t, err, "unauthenticated")
}

func TestBotParentRevocationAndBrowserIdentityAreRechecked(t *testing.T) {
	f, out, _, _ := connectBot(t)
	ctx := context.Background()
	v := out.Session
	other := addMember(t, f, "admin")
	_, err := f.s.TestSnapshot(ctx, other, v.SessionID)
	botFault(t, err, "forbidden")
	fresh := f.p
	fresh.CredentialID = uuid.NewString()
	if _, err = f.s.DB.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES($1,$2,$3,'fresh',now())`, fresh.CredentialID, fresh.UserID, []byte("01234567890123456789012345678901")); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.DB.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, f.p.CredentialID); err != nil {
		t.Fatal(err)
	}
	_, err = f.s.TestSnapshot(ctx, fresh, v.SessionID)
	botFault(t, err, "unauthenticated")
	_, err = f.s.Poll(ctx, v.ControllerFence)
	botFault(t, err, "unauthenticated")
	_, err = f.s.ReportBot(ctx, fresh, out.Bot.WorkerID, out.Bot.ID, readyBotReport(out))
	botFault(t, err, "unauthenticated")
	g := BotGrant{BotVersion: out.Bot.Version, Grant: sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, ExecutionGeneration: "1", Kind: "reconnect"}}
	_, err = f.s.GrantBot(ctx, fresh, out.Bot.WorkerID, out.Bot.ID, g)
	botFault(t, err, "unauthenticated")
}

func TestBotReportRechecksReadinessEvenWhenTheStoredResultMatches(t *testing.T) {
	f, out, _, _ := connectBot(t)
	ctx := context.Background()
	v := out.Session
	state := sp.State{InitialInputState: "not_required", Synchronized: true, Activity: "idle"}
	if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "sync_state", ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
		t.Fatal(err)
	}
	report := readyBotReport(out)
	ready, err := f.s.ReportBot(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, report)
	if err != nil {
		t.Fatal(err)
	}
	report.BotVersion = ready.Version
	same, err := f.s.ReportBot(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, report)
	if err != nil || same.Version != ready.Version {
		t.Fatal("no-op report advanced version", err)
	}
	f.s.now = func() time.Time { return time.Now().Add(HeartbeatTimeout + time.Second) }
	_, err = f.s.ReportBot(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, report)
	botFault(t, err, "controller_offline")
}

func TestOrdinaryRegistrationRejectsBotWithoutWaitingOnItsLock(t *testing.T) {
	f, out, input := registeredBot(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	tx, err := f.s.DB.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT id FROM bots WHERE id=$1 FOR UPDATE`, out.Bot.ID); err != nil {
		t.Fatal(err)
	}
	_, err = f.s.RegisterTest(ctx, f.p, input.Registration)
	botFault(t, err, "forbidden")
}

func TestBotDeletionCommitPrecedesWaitingBrowserAndControllerAdmission(t *testing.T) {
	for _, path := range []string{"browser", "controller"} {
		t.Run(path, func(t *testing.T) {
			f, out, _, _ := connectBot(t)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			tx, err := f.s.DB.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			if _, err = tx.Exec(ctx, `UPDATE bots SET deletion=$2 WHERE id=$1`, out.Bot.ID, encode(model.BotDeletion{DeletionID: uuid.NewString(), RequestedVersion: out.Bot.Version, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}})); err != nil {
				t.Fatal(err)
			}
			result := make(chan error, 1)
			go func() {
				if path == "browser" {
					_, e := f.s.TestSnapshot(ctx, f.p, out.Session.SessionID)
					result <- e
				} else {
					_, e := f.s.Handle(ctx, sp.ControllerMessage{Type: "heartbeat", ControllerFence: out.Session.ControllerFence})
					result <- e
				}
			}()
			waitErr := waitArchiveLock(ctx, f, "SELECT id::text FROM bots WHERE id=")
			commitErr := tx.Commit(ctx)
			err = <-result
			if waitErr != nil || commitErr != nil {
				t.Fatalf("deletion transaction: %v %v", waitErr, commitErr)
			}
			botFault(t, err, "resource_conflict")
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
				f, out, _, _ := connectBot(t)
				ctx := context.Background()
				v := out.Session
				state := sp.State{InitialInputState: "not_required", Synchronized: true, Activity: "idle"}
				if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "sync_state", ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
					t.Fatal(err)
				}
				if alreadyReady {
					ready, err := f.s.ReportBot(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, readyBotReport(out))
					if err != nil {
						t.Fatal(err)
					}
					out.Bot = ready
				}
				replacement := f.p
				replacement.CredentialID = uuid.NewString()
				if _, err := f.s.DB.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES($1,$2,$3,'replacement',now())`, replacement.CredentialID, replacement.UserID, []byte("01234567890123456789012345678901")); err != nil {
					t.Fatal(err)
				}
				grant, err := f.s.GrantBot(ctx, replacement, out.Bot.WorkerID, out.Bot.ID, BotGrant{BotVersion: out.Bot.Version, Grant: sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, ExecutionGeneration: v.ExecutionGeneration, Kind: "reconnect"}})
				if err != nil {
					t.Fatal(err)
				}
				if invalidation == "revoked" {
					_, err = f.s.DB.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, f.p.CredentialID)
				} else {
					_, err = f.s.DB.Pool.Exec(ctx, `UPDATE personal_access_tokens SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE id=$1`, f.p.CredentialID)
				}
				if err != nil {
					t.Fatal(err)
				}
				result, err := f.s.ReportBot(ctx, replacement, out.Bot.WorkerID, out.Bot.ID, readyBotReport(out))
				if err == nil {
					t.Fatalf("replacement grant accepted synchronization from a revoked connection: startup=%s version=%d", result.StartupResult.State, result.Version)
				}
				botFault(t, err, "unauthenticated")
				current, err := botservice.New(f.s.DB).Get(ctx, replacement, out.Bot.ID)
				if err != nil || current.Version != out.Bot.Version || current.StartupResult.State != out.Bot.StartupResult.State {
					t.Fatalf("rejected report changed startup: %+v %v", current, err)
				}
				var preferences int
				if err = f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM bot_worker_preferences WHERE user_id=$1`, f.p.UserID).Scan(&preferences); err != nil {
					t.Fatal(err)
				}
				expectedPreferences := 0
				if alreadyReady {
					expectedPreferences = 1
				}
				if preferences != expectedPreferences {
					t.Fatalf("rejected report changed preferences: got %d want %d", preferences, expectedPreferences)
				}

				// A replacement PAT grants readiness only after its own connection consumes
				// the grant and publishes a new synchronization observation.
				var sourceEpoch string
				if err = f.s.DB.Pool.QueryRow(ctx, `SELECT source_epoch::text FROM task_sessions WHERE id=$1`, v.SessionID).Scan(&sourceEpoch); err != nil {
					t.Fatal(err)
				}
				out.Session, err = f.s.Connect(ctx, grant.Token, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, Provider: v.Identity.Provider, SourceEpoch: sourceEpoch, LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}, uuid.NewString())
				if err != nil {
					t.Fatal(err)
				}
				if _, err = f.s.Handle(ctx, sp.ControllerMessage{Type: "sync_state", ControllerFence: out.Session.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
					t.Fatal(err)
				}
				result, err = f.s.ReportBot(ctx, replacement, out.Bot.WorkerID, out.Bot.ID, readyBotReport(out))
				if err != nil || result.StartupResult.State != "ready" {
					t.Fatalf("replacement connection's synchronization was rejected: %+v %v", result, err)
				}
			})
		}
	}
}
