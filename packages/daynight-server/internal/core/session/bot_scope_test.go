package session

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestBotRegistrationFreezesRoleAndReconcilesOriginalBinding(t *testing.T) {
	f, bot, input := botFixture(t)
	first, err := f.s.RegisterBot(botPhase(t, f, t.Context(), map[string]int{"LockCredential": 2, "InsertBotSession": 1, "Bot": 1, "BindBotSession": 1}), f.p, bot.WorkerID, bot.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	selectBotBinding(t, f, first)
	again, err := f.s.RegisterBot(botPhase(t, f, t.Context(), map[string]int{"LockCredential": 3, "LockSession": 1, "Bot": 1}), f.p, bot.WorkerID, bot.ID, input)
	if err != nil || again.Session.SessionID != first.Session.SessionID || botDAO(f).bindCalls != 1 {
		t.Fatalf("registration did not reconcile frozen binding: %+v %v", again, err)
	}
	for _, out := range []BotRegistrationResult{first, again} {
		if out.Bot.TestExecutionID == nil || *out.Bot.TestExecutionID != input.Registration.TestExecutionID || out.Bot.Version != 2 || out.Bot.RoleConfiguration == nil || *out.Bot.RoleConfiguration != input.RoleConfiguration || out.Bot.SessionID == nil || *out.Bot.SessionID != out.Session.SessionID || out.Session.InitialInputState != "not_required" {
			t.Fatalf("registration changed frozen binding: %+v", out)
		}
		if _, err := sp.DecodeSnapshot(encode(out.Session)); err != nil {
			t.Fatal(err)
		}
	}
	for _, mutate := range []func(*BotRegistration){
		func(v *BotRegistration) { v.RoleConfiguration.Revision = "2" },
		func(v *BotRegistration) { v.Registration.RegistrationID = uuid.NewString() },
	} {
		changed := input
		mutate(&changed)
		if _, err := f.s.RegisterBot(botPhase(t, f, t.Context(), map[string]int{"LockCredential": 1, "LockSession": 1, "Bot": 1}), f.p, bot.WorkerID, bot.ID, changed); err == nil {
			t.Fatal("retry rewrote frozen registration")
		}
	}
	if _, err := f.s.RegisterTest(botPhase(t, f, t.Context(), map[string]int{"LockCredential": 1, "LockTestOwner": 1, "FindTestRegistration": 1}), f.p, input.Registration); err == nil {
		t.Fatal("ordinary registration accessed Bot")
	}
	page, err := f.s.ListTest(botPhase(t, f, t.Context(), map[string]int{"LockCredential": 1, "ListTestSessions": 1}), f.p, "", 10, false)
	if err != nil || len(page.Items) != 0 {
		t.Fatalf("Bot leaked into ordinary inventory: %+v %v", page, err)
	}
}

func TestBotGrantAndReportRequireCurrentBindingAndLiveSynchronization(t *testing.T) {
	f, out, _, _ := connectedBotFixture(t)
	ctx := context.Background()
	report := readyBotReport(out)
	if _, err := f.s.ReportBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 3, "LockSession": 1, "Bot": 1}), f.p, out.Bot.WorkerID, out.Bot.ID, report); err == nil {
		t.Fatal("spawn/hello incorrectly proved readiness")
	}
	state := sp.State{InitialInputState: "not_required", Synchronized: true, Activity: "idle"}
	if _, err := f.s.Handle(botPhase(t, f, ctx, map[string]int{"SessionLocation": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 2, "UnreconciledSessionOperationCount": 1, "TouchSession": 1, "SaveSession": 1, "Bot": 1}), sp.ControllerMessage{Type: "sync_state", ControllerFence: out.Session.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
		t.Fatal(err)
	}
	f.SelectSessionWrite(t)
	if _, err := New(f.writer).ReportBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 3, "LockSession": 1, "Bot": 1}), f.p, out.Bot.WorkerID, out.Bot.ID, report); err == nil {
		t.Fatal("another service invented live synchronization")
	}
	wrong := report
	native := "not-the-session"
	wrong.NativeSessionID = &native
	if _, err := f.s.ReportBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 3, "LockSession": 1, "Bot": 1}), f.p, out.Bot.WorkerID, out.Bot.ID, wrong); err == nil {
		t.Fatal("wrong native identity accepted")
	}
	wrong = report
	fence := *report.Fence
	fence.ConnectionEpoch = "2"
	wrong.Fence = &fence
	if _, err := f.s.ReportBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 3, "LockSession": 1, "Bot": 1}), f.p, out.Bot.WorkerID, out.Bot.ID, wrong); err == nil {
		t.Fatal("stale connection accepted")
	}
	ready, err := f.s.ReportBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 4, "LockSession": 1, "Bot": 1, "SetBotStartup": 1, "CommitBotPreferences": 1}), f.p, out.Bot.WorkerID, out.Bot.ID, report)
	if err != nil || ready.Version != 3 || ready.StartupResult.State != "ready" {
		t.Fatalf("synchronized lazy native was not ready: %+v %v", ready, err)
	}
	selectBotStartup(t, f, ready)
	if botDAO(f).preferenceCalls != 1 {
		t.Fatal("ready report did not propose successful preferences exactly once")
	}
	if _, err = f.s.ReportBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 1, "Bot": 1}), f.p, out.Bot.WorkerID, out.Bot.ID, report); err == nil {
		t.Fatal("stale report version accepted")
	}
	g := sp.Grant{Protocol: sp.Protocol, TestExecutionID: out.Session.TestExecutionID, ControllerID: out.Session.Identity.ControllerID, ControllerInstanceID: out.Session.Identity.ControllerInstanceID, ExecutionGeneration: "1", Kind: "reconnect"}
	if _, err = f.s.Grant(botPhase(t, f, ctx, map[string]int{"SessionBotID": 1, "LockSession": 1, "LockCredential": 2, "Bot": 1}), f.p, "", "", out.Session.SessionID, g); err == nil {
		t.Fatal("ordinary grant bypassed Bot")
	}
	if _, err = f.s.StopTest(botPhase(t, f, ctx, map[string]int{"SessionBotID": 1, "LockSession": 1, "LockCredential": 2, "Bot": 1}), f.p, out.Session.SessionID, sp.TestStop{}); err == nil {
		t.Fatal("ordinary stop bypassed Bot")
	}
	if _, err = f.s.GrantBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 1, "Bot": 1}), f.p, out.Bot.WorkerID, out.Bot.ID, BotGrant{BotVersion: 2, Grant: g}); err == nil {
		t.Fatal("stale Bot version granted")
	}
	if _, err = f.s.GrantBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 1, "Bot": 1}), f.p, uuid.NewString(), out.Bot.ID, BotGrant{BotVersion: 3, Grant: g}); err == nil {
		t.Fatal("wrong Worker granted")
	}
	if _, err = f.s.GrantBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 3, "LockSession": 1, "SetSessionGrant": 1, "SaveSession": 1, "Bot": 1}), f.p, out.Bot.WorkerID, out.Bot.ID, BotGrant{BotVersion: 3, Grant: g}); err != nil {
		t.Fatal(err)
	}
}
func TestBotPreflightFailureCannotInventSessionOrSuccessfulPreference(t *testing.T) {
	f, bot, _ := botFixture(t)
	ctx := context.Background()
	code := "directory_missing"
	report := BotReport{BotVersion: 1, Result: model.BotStartupResult{State: "failed", Code: &code}}
	out, err := f.s.ReportBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 2, "Bot": 1, "SetBotStartup": 1}), f.p, bot.WorkerID, bot.ID, report)
	if err != nil || out.Version != 2 || out.StartupResult.State != "failed" || out.SessionID != nil {
		t.Fatalf("preflight result %+v %v", out, err)
	}
	if botDAO(f).preferenceCalls != 0 || botDAO(f).bindCalls != 0 {
		t.Fatal("preflight failure proposed preferences or Session binding")
	}
	selectBotStartup(t, f, out)
	report.BotVersion = 2
	report.Result = model.BotStartupResult{State: "ready"}
	if _, err = f.s.ReportBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 1, "Bot": 1}), f.p, bot.WorkerID, bot.ID, report); err == nil {
		t.Fatal("preflight reported ready without a Session")
	}
}

func TestBotUnboundLifecycleRevalidatesCredentialAfterObservedBot(t *testing.T) {
	for _, operation := range []string{"register", "report", "report_replay"} {
		for _, expired := range []bool{true, false} {
			name := operation + "/valid"
			if expired {
				name = operation + "/expired"
			}
			t.Run(name, func(t *testing.T) {
				f, bot, registration := botFixture(t)
				code := "directory_missing"
				report := BotReport{BotVersion: bot.Version, Result: model.BotStartupResult{State: "failed", Code: &code}}
				if operation == "report_replay" {
					var err error
					bot, err = f.s.ReportBot(botPhase(t, f, t.Context(), map[string]int{"LockCredential": 2, "Bot": 1, "SetBotStartup": 1}), f.p, bot.WorkerID, bot.ID, report)
					if err != nil {
						t.Fatal(err)
					}
					selectBotStartup(t, f, bot)
					report.BotVersion = bot.Version
				}
				initial := time.Date(2026, 11, 8, 1, 0, 0, 0, time.UTC)
				later := initial.Add(time.Hour)
				now := initial
				f.s.now = func() time.Time { return now }
				calls := 0
				f.dao.LockCredentialFn = func(_ context.Context, p model.Principal, actual time.Time) error {
					calls++
					if p != f.p {
						t.Fatal("recheck changed credential identity")
					}
					expected := initial
					if calls > 1 {
						expected = later
					}
					if !actual.Equal(expected) {
						t.Fatalf("credential clock: %v want %v", actual, expected)
					}
					if calls > 1 && expired {
						return fault("unauthenticated", "Credential expired.")
					}
					return nil
				}
				botDAO(f).BotFn = func(_ context.Context, id string) (model.Bot, error) {
					if id != bot.ID || calls != 1 {
						t.Fatal("Bot response preceded initial credential validation")
					}
					now = later
					return bot, nil
				}
				beforeStartup := botDAO(f).startupCalls
				var err error
				if operation == "register" {
					_, err = f.s.RegisterBot(botPhase(t, f, t.Context(), map[string]int{"LockCredential": 2, "InsertBotSession": 1, "Bot": 1, "BindBotSession": 1}), f.p, bot.WorkerID, bot.ID, registration)
				} else {
					counts := map[string]int{"LockCredential": 2, "Bot": 1}
					if operation == "report" {
						counts["SetBotStartup"] = 1
					}
					_, err = f.s.ReportBot(botPhase(t, f, t.Context(), counts), f.p, bot.WorkerID, bot.ID, report)
				}
				if calls != 2 {
					t.Fatalf("credential checked %d times", calls)
				}
				if expired {
					botFault(t, err, "unauthenticated")
				} else if err != nil {
					t.Fatal(err)
				}
				if botDAO(f).preferenceCalls != 0 {
					t.Fatal("unbound operation proposed successful preferences")
				}
				if operation == "report_replay" && botDAO(f).startupCalls != beforeStartup {
					t.Fatal("exact report replay proposed another write")
				}
			})
		}
	}
}

func TestBotRecoveryRequiresNativeIdentityAndExactOriginalStopProof(t *testing.T) {
	f, out, _, _ := connectedBotFixture(t)
	ctx := context.Background()
	v := out.Session
	previous := "1"
	grant := BotGrant{BotVersion: out.Bot.Version, Grant: sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: v.Identity.ControllerID, ControllerInstanceID: uuid.NewString(), ExecutionGeneration: "2", Kind: "reconnect", PreviousGeneration: &previous, StopProof: &sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: v.Identity.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}}
	if _, err := f.s.GrantBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 3, "LockSession": 1, "Bot": 1}), f.p, out.Bot.WorkerID, out.Bot.ID, grant); err == nil {
		t.Fatal("recovery without a native identity")
	}
	native := "original-native"
	state := sp.State{NativeSessionID: &native, InitialInputState: "not_required", Synchronized: true, Activity: "idle"}
	if _, err := f.s.Handle(botPhase(t, f, ctx, map[string]int{"SessionLocation": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 2, "UnreconciledSessionOperationCount": 1, "TouchSession": 1, "SaveSession": 1, "Bot": 1}), sp.ControllerMessage{Type: "sync_state", ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
		t.Fatal(err)
	}
	f.SelectSessionWrite(t)
	grant.NativeSessionID = &native
	for name, mutate := range map[string]func(*BotGrant){
		"missing native":      func(g *BotGrant) { g.NativeSessionID = nil },
		"different native":    func(g *BotGrant) { n := "another-native"; g.NativeSessionID = &n },
		"generation":          func(g *BotGrant) { g.Grant.ExecutionGeneration = "3" },
		"controller instance": func(g *BotGrant) { g.Grant.ControllerInstanceID = v.Identity.ControllerInstanceID },
		"missing proof":       func(g *BotGrant) { g.Grant.StopProof = nil },
		"proof kind":          func(g *BotGrant) { p := *g.Grant.StopProof; p.Kind = "never_started"; g.Grant.StopProof = &p },
		"future stop": func(g *BotGrant) {
			p := *g.Grant.StopProof
			p.StoppedAt = time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
			g.Grant.StopProof = &p
		},
	} {
		bad := grant
		mutate(&bad)
		counts := map[string]int{"LockCredential": 3, "LockSession": 1, "Bot": 1}
		if name == "missing proof" || name == "proof kind" {
			counts = map[string]int{}
		}
		if _, err := f.s.GrantBot(botPhase(t, f, ctx, counts), f.p, out.Bot.WorkerID, out.Bot.ID, bad); err == nil {
			t.Fatalf("invalid recovery %s admitted", name)
		}
	}
	recovered, err := f.s.GrantBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 3, "LockSession": 1, "SetSessionGrant": 1, "SaveSession": 1, "SetSessionGenerationStop": 1, "Bot": 1}), f.p, out.Bot.WorkerID, out.Bot.ID, grant)
	if err != nil || recovered.ExecutionGeneration != "2" {
		t.Fatalf("recovery %+v %v", recovered, err)
	}
	selectBotGrant(t, f, recovered)
	if _, err = f.s.Poll(botPhase(t, f, ctx, map[string]int{"SessionLocation": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 2, "Bot": 1}), v.ControllerFence); err == nil {
		t.Fatal("old generation remains authorized")
	}
	if _, err = f.s.GrantBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 3, "LockSession": 1, "SetSessionGrant": 1, "SaveSession": 1, "Bot": 1}), f.p, out.Bot.WorkerID, out.Bot.ID, grant); err != nil {
		t.Fatal("lost response retry failed", err)
	}
	proof := *grant.Grant.StopProof
	proof.RecordID = uuid.NewString()
	grant.Grant.StopProof = &proof
	if _, err = f.s.GrantBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 3, "LockSession": 1, "Bot": 1}), f.p, out.Bot.WorkerID, out.Bot.ID, grant); err == nil {
		t.Fatal("different proof reused recovered generation")
	}
	current, err := f.s.TestSnapshot(botPhase(t, f, ctx, map[string]int{"SessionBotID": 1, "LockSession": 1, "LockCredential": 2, "Bot": 1}), f.p, v.SessionID)
	if err != nil || current.Identity.NativeSessionID == nil || *current.Identity.NativeSessionID != native || current.TestExecutionID != v.TestExecutionID {
		t.Fatalf("recovery replaced stable identity %+v %v", current, err)
	}
}
