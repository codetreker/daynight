package sessionrelay

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	"github.com/google/uuid"
)

func botFixture(t *testing.T) (fixture, model.Bot, BotRegistration) {
	t.Helper()
	f := setup(t)
	ctx := context.Background()
	if _, err := f.s.DB.Pool.Exec(ctx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,now(),now(),'{}','{}')`, f.p.UserID, f.r.WorkerID); err != nil {
		t.Fatal(err)
	}
	configuration := model.BotConfiguration{WorkerID: f.r.WorkerID, Cwd: "/ordinary/directory", Provider: "codex", Args: []string{}}
	worker := f.r.WorkerID
	bot, err := botservice.New(f.s.DB).Create(ctx, f.p, botcore.CreateBot{ID: uuid.NewString(), Name: "Assistant", Overrides: model.BotOverrides{WorkerID: &worker}, ResolvedConfiguration: configuration})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("Use Daynight CLI."))
	input := BotRegistration{BotVersion: bot.Version, Configuration: configuration, RoleConfiguration: model.BotRoleConfiguration{Instructions: "Use Daynight CLI.", Revision: "1", Digest: hex.EncodeToString(digest[:])}, Registration: sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}}
	return f, bot, input
}

func TestBotRegistrationFreezesOneRoleAndSessionAcrossConcurrentRetries(t *testing.T) {
	f, bot, input := botFixture(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	results := make(chan BotRegistrationResult, 2)
	errs := make(chan error, 2)
	for range 2 {
		wg.Go(func() {
			out, err := f.s.RegisterBot(ctx, f.p, bot.WorkerID, bot.ID, input)
			results <- out
			errs <- err
		})
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	id := ""
	for out := range results {
		if id != "" && out.Session.SessionID != id {
			t.Fatal("parallel registration created another session")
		}
		id = out.Session.SessionID
		if out.Bot.TestExecutionID == nil || *out.Bot.TestExecutionID != input.Registration.TestExecutionID || out.Bot.Version != 2 || out.Bot.RoleConfiguration == nil || *out.Bot.RoleConfiguration != input.RoleConfiguration || out.Bot.SessionID == nil || *out.Bot.SessionID != id || out.Session.TestExecutionID != input.Registration.TestExecutionID || out.Session.InitialInputState != "not_required" {
			t.Fatalf("binding not frozen atomically: %+v", out)
		}
		if _, err := sp.DecodeSnapshot(encode(out.Session)); err != nil {
			t.Fatalf("Bot changed independent wire branch: %v", err)
		}
	}
	var sessions int
	if err := f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM task_sessions WHERE bot_id=$1`, bot.ID).Scan(&sessions); err != nil || sessions != 1 {
		t.Fatalf("session count %d %v", sessions, err)
	}
	changed := input
	changed.RoleConfiguration.Revision = "2"
	if _, err := f.s.RegisterBot(ctx, f.p, bot.WorkerID, bot.ID, changed); err == nil {
		t.Fatal("registration rewrote role")
	}
	changed = input
	changed.Registration.RegistrationID = uuid.NewString()
	if _, err := f.s.RegisterBot(ctx, f.p, bot.WorkerID, bot.ID, changed); err == nil {
		t.Fatal("second registration accepted")
	}
	if _, err := f.s.RegisterTest(ctx, f.p, input.Registration); err == nil {
		t.Fatal("ordinary registration accessed Bot")
	}
	page, err := f.s.ListTest(ctx, f.p, "", 10, false)
	if err != nil || len(page.Items) != 0 {
		t.Fatalf("Bot leaked into ordinary Test inventory: %+v %v", page, err)
	}
}

func registeredBot(t *testing.T) (fixture, BotRegistrationResult, BotRegistration) {
	t.Helper()
	f, bot, input := botFixture(t)
	out, err := f.s.RegisterBot(context.Background(), f.p, bot.WorkerID, bot.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	return f, out, input
}
func connectBot(t *testing.T) (fixture, BotRegistrationResult, BotRegistration, GrantResult) {
	t.Helper()
	f, out, input := registeredBot(t)
	v := out.Session
	grant, err := f.s.GrantBot(context.Background(), f.p, out.Bot.WorkerID, out.Bot.ID, BotGrant{BotVersion: out.Bot.Version, Grant: sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, ExecutionGeneration: v.ExecutionGeneration, Kind: "bootstrap"}})
	if err != nil {
		t.Fatal(err)
	}
	out.Session, err = f.s.Connect(context.Background(), grant.Token, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, Provider: v.Identity.Provider, SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	return f, out, input, grant
}
func readyBotReport(out BotRegistrationResult) BotReport {
	fence := out.Session.ControllerFence
	return BotReport{BotVersion: out.Bot.Version, Fence: &fence, ControllerID: out.Session.Identity.ControllerID, ControllerInstanceID: out.Session.Identity.ControllerInstanceID, NativeSessionID: out.Session.Identity.NativeSessionID, Result: model.BotStartupResult{State: "ready"}}
}
func TestBotGrantAndReportRequireCurrentBindingAndLiveSynchronization(t *testing.T) {
	f, out, _, _ := connectBot(t)
	ctx := context.Background()
	report := readyBotReport(out)
	if _, err := f.s.ReportBot(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, report); err == nil {
		t.Fatal("spawn/hello incorrectly proved readiness")
	}
	state := sp.State{InitialInputState: "not_required", Synchronized: true, Activity: "idle"}
	if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "sync_state", ControllerFence: out.Session.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
		t.Fatal(err)
	}
	if _, err := New(f.s.DB).ReportBot(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, report); err == nil {
		t.Fatal("another service invented live synchronization")
	}
	wrong := report
	native := "not-the-session"
	wrong.NativeSessionID = &native
	if _, err := f.s.ReportBot(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, wrong); err == nil {
		t.Fatal("wrong native identity accepted")
	}
	wrong = report
	fence := *report.Fence
	fence.ConnectionEpoch = "2"
	wrong.Fence = &fence
	if _, err := f.s.ReportBot(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, wrong); err == nil {
		t.Fatal("stale connection accepted")
	}
	ready, err := f.s.ReportBot(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, report)
	if err != nil || ready.Version != 3 || ready.StartupResult.State != "ready" {
		t.Fatalf("synchronized lazy native was not ready: %+v %v", ready, err)
	}
	var preferred string
	if err = f.s.DB.Pool.QueryRow(ctx, `SELECT worker_id::text FROM bot_worker_preferences WHERE user_id=$1`, f.p.UserID).Scan(&preferred); err != nil || preferred != out.Bot.WorkerID {
		t.Fatalf("successful preferences missing %s %v", preferred, err)
	}
	if _, err = f.s.ReportBot(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, report); err == nil {
		t.Fatal("stale report version accepted")
	}
	g := sp.Grant{Protocol: sp.Protocol, TestExecutionID: out.Session.TestExecutionID, ControllerID: out.Session.Identity.ControllerID, ControllerInstanceID: out.Session.Identity.ControllerInstanceID, ExecutionGeneration: "1", Kind: "reconnect"}
	if _, err = f.s.Grant(ctx, f.p, "", "", out.Session.SessionID, g); err == nil {
		t.Fatal("ordinary grant bypassed Bot")
	}
	if _, err = f.s.StopTest(ctx, f.p, out.Session.SessionID, sp.TestStop{}); err == nil {
		t.Fatal("ordinary stop bypassed Bot")
	}
	if _, err = f.s.GrantBot(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, BotGrant{BotVersion: 2, Grant: g}); err == nil {
		t.Fatal("stale Bot version granted")
	}
	if _, err = f.s.GrantBot(ctx, f.p, uuid.NewString(), out.Bot.ID, BotGrant{BotVersion: 3, Grant: g}); err == nil {
		t.Fatal("wrong Worker granted")
	}
	if _, err = f.s.GrantBot(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, BotGrant{BotVersion: 3, Grant: g}); err != nil {
		t.Fatal(err)
	}
}
func TestBotPreflightFailureCannotInventSessionOrSuccessfulPreference(t *testing.T) {
	f, bot, _ := botFixture(t)
	ctx := context.Background()
	code := "directory_missing"
	report := BotReport{BotVersion: 1, Result: model.BotStartupResult{State: "failed", Code: &code}}
	out, err := f.s.ReportBot(ctx, f.p, bot.WorkerID, bot.ID, report)
	if err != nil || out.Version != 2 || out.StartupResult.State != "failed" || out.SessionID != nil {
		t.Fatalf("preflight result %+v %v", out, err)
	}
	var count int
	if err = f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM bot_worker_preferences`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("failure saved preference %d %v", count, err)
	}
	report.BotVersion = 2
	report.Result = model.BotStartupResult{State: "ready"}
	if _, err = f.s.ReportBot(ctx, f.p, bot.WorkerID, bot.ID, report); err == nil {
		t.Fatal("preflight reported ready without a Session")
	}
}

func TestBotUnboundLifecycleRevalidatesCredentialAfterLockWait(t *testing.T) {
	for _, operation := range []string{"register", "report", "report_replay"} {
		for _, expired := range []bool{true, false} {
			name := operation + "/valid"
			if expired {
				name = operation + "/expired"
			}
			t.Run(name, func(t *testing.T) {
				f, bot, registration := botFixture(t)
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				code := "directory_missing"
				report := BotReport{BotVersion: bot.Version, Result: model.BotStartupResult{State: "failed", Code: &code}}
				if operation == "report_replay" {
					var err error
					bot, err = f.s.ReportBot(ctx, f.p, bot.WorkerID, bot.ID, report)
					if err != nil {
						t.Fatal(err)
					}
					report.BotVersion = bot.Version
				}
				stored := func() string {
					var state string
					if err := f.s.DB.Pool.QueryRow(ctx, `SELECT jsonb_build_object('bot',to_jsonb(b),'sessions',(SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) FROM task_sessions s WHERE s.bot_id=b.id),'workerPreferences',(SELECT COALESCE(jsonb_agg(to_jsonb(p)),'[]'::jsonb) FROM bot_worker_preferences p WHERE p.user_id=b.owner_user_id),'configurationPreferences',(SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.worker_id),'[]'::jsonb) FROM bot_configuration_preferences p WHERE p.user_id=b.owner_user_id))::text FROM bots b WHERE b.id=$1`, bot.ID).Scan(&state); err != nil {
						t.Fatal(err)
					}
					return state
				}
				before := stored()
				lock, err := f.s.DB.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer lock.Rollback(context.Background())
				if _, err = lock.Exec(ctx, "SELECT id FROM bots WHERE id=$1 FOR UPDATE", bot.ID); err != nil {
					t.Fatal(err)
				}
				if expired {
					if _, err = f.s.DB.Pool.Exec(ctx, "UPDATE personal_access_tokens SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", f.p.CredentialID); err != nil {
						t.Fatal(err)
					}
				}
				var out model.Bot
				finished := make(chan struct{})
				go func() {
					defer close(finished)
					if operation == "register" {
						var result BotRegistrationResult
						result, err = f.s.RegisterBot(ctx, f.p, bot.WorkerID, bot.ID, registration)
						out = result.Bot
					} else {
						out, err = f.s.ReportBot(ctx, f.p, bot.WorkerID, bot.ID, report)
					}
				}()
				defer func() {
					_ = lock.Rollback(context.Background())
					cancel()
					select {
					case <-finished:
					case <-time.After(3 * time.Second):
						t.Error("Bot operation did not stop during cleanup")
					}
				}()
				wait := func(expiry bool) {
					t.Helper()
					ticker := time.NewTicker(5 * time.Millisecond)
					defer ticker.Stop()
					for {
						var observed bool
						var e error
						if expiry {
							e = f.s.DB.Pool.QueryRow(ctx, "SELECT expires_at<=clock_timestamp() FROM personal_access_tokens WHERE id=$1", f.p.CredentialID).Scan(&observed)
						} else {
							e = f.s.DB.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1::integer=ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT id::text FROM bots WHERE id=%')`, int32(lock.Conn().PgConn().PID())).Scan(&observed)
						}
						if e != nil {
							t.Fatal(e)
						}
						if observed {
							return
						}
						select {
						case <-finished:
							t.Fatal("Bot operation ended before lock/expiry observation")
						case <-ctx.Done():
							t.Fatal("Bot lock/expiry observation timed out")
						case <-ticker.C:
						}
					}
				}
				wait(false)
				if expired {
					wait(true)
				}
				// Releasing an unchanged Bot avoids disguising expiry as a version conflict.
				if e := lock.Commit(ctx); e != nil {
					t.Fatal(e)
				}
				select {
				case <-finished:
				case <-ctx.Done():
					t.Fatal("Bot operation did not finish after lock release")
				}
				if expired {
					botFault(t, err, "unauthenticated")
					if stored() != before {
						t.Fatal("expired PAT changed Bot, role, Session or preferences")
					}
				} else if err != nil || out.Version != 2 {
					t.Fatalf("valid PAT changed lifecycle behavior: version=%d error=%v", out.Version, err)
				} else if operation == "report_replay" && stored() != before {
					t.Fatal("same-result report changed persisted state")
				} else if operation == "register" {
					if out.RoleConfiguration == nil || *out.RoleConfiguration != registration.RoleConfiguration || out.SessionID == nil || out.TestExecutionID == nil || *out.TestExecutionID != registration.Registration.TestExecutionID || stored() == before {
						t.Fatal("valid PAT did not persist the frozen binding")
					}
				} else if !jsonEqual(encode(out.StartupResult), encode(report.Result)) || out.SessionID != nil || out.RoleConfiguration != nil {
					t.Fatal("valid PAT changed preflight result behavior")
				}
			})
		}
	}
}

func TestBotRecoveryRequiresNativeIdentityAndExactOriginalStopProof(t *testing.T) {
	f, out, _, _ := connectBot(t)
	ctx := context.Background()
	v := out.Session
	previous := "1"
	grant := BotGrant{BotVersion: out.Bot.Version, Grant: sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: v.Identity.ControllerID, ControllerInstanceID: uuid.NewString(), ExecutionGeneration: "2", Kind: "reconnect", PreviousGeneration: &previous, StopProof: &sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: v.Identity.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}}
	if _, err := f.s.GrantBot(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, grant); err == nil {
		t.Fatal("recovery without a native identity")
	}
	native := "original-native"
	state := sp.State{NativeSessionID: &native, InitialInputState: "not_required", Synchronized: true, Activity: "idle"}
	if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "sync_state", ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
		t.Fatal(err)
	}
	grant.NativeSessionID = &native
	for _, mutate := range []func(*BotGrant){
		func(g *BotGrant) { g.NativeSessionID = nil },
		func(g *BotGrant) { n := "another-native"; g.NativeSessionID = &n },
		func(g *BotGrant) { g.Grant.ExecutionGeneration = "3" },
		func(g *BotGrant) { g.Grant.ControllerInstanceID = v.Identity.ControllerInstanceID },
		func(g *BotGrant) { g.Grant.StopProof = nil },
		func(g *BotGrant) { p := *g.Grant.StopProof; p.Kind = "never_started"; g.Grant.StopProof = &p },
		func(g *BotGrant) {
			p := *g.Grant.StopProof
			p.StoppedAt = time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
			g.Grant.StopProof = &p
		},
	} {
		bad := grant
		mutate(&bad)
		if _, err := f.s.GrantBot(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, bad); err == nil {
			t.Fatal("invalid recovery admitted")
		}
	}
	recovered, err := f.s.GrantBot(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, grant)
	if err != nil || recovered.ExecutionGeneration != "2" {
		t.Fatalf("recovery %+v %v", recovered, err)
	}
	if _, err = f.s.Poll(ctx, v.ControllerFence); err == nil {
		t.Fatal("old generation remains authorized")
	}
	if _, err = f.s.GrantBot(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, grant); err != nil {
		t.Fatal("lost response retry failed", err)
	}
	proof := *grant.Grant.StopProof
	proof.RecordID = uuid.NewString()
	grant.Grant.StopProof = &proof
	if _, err = f.s.GrantBot(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, grant); err == nil {
		t.Fatal("different proof reused recovered generation")
	}
	current, err := f.s.TestSnapshot(ctx, f.p, v.SessionID)
	if err != nil || current.Identity.NativeSessionID == nil || *current.Identity.NativeSessionID != native || current.TestExecutionID != v.TestExecutionID {
		t.Fatalf("recovery replaced stable identity %+v %v", current, err)
	}
}
