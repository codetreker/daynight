package service

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func reportBotHost(t *testing.T, database *store.Store, principal model.Principal, workerID, cwd string) {
	t.Helper()
	report := serviceWorkerReport()
	report.Telemetry.AssistantHost = validAssistantHost()
	report.Telemetry.AssistantHost.ObservedAt = time.Now().UTC().Add(-time.Second)
	report.Telemetry.AssistantHost.DefaultCwd = cwd
	if _, err := NewWorkers(database).Report(context.Background(), principal, workerID, report); err != nil {
		t.Fatal(err)
	}
}

func TestBotResolvedNameOnlyFreezesAndReconcilesOriginalID(t *testing.T) {
	bots, db, principal, worker := botService(t)
	ctx := context.Background()
	reportBotHost(t, db, principal, worker, "/ordinary/not-on-server")
	input := CreateBot{ID: uuid.NewString(), Name: " Name only "}
	created, err := bots.CreateResolved(ctx, principal, input)
	if err != nil {
		t.Fatal(err)
	}
	want := model.BotConfiguration{WorkerID: worker, Cwd: "/ordinary/not-on-server", Provider: "copilot", Model: workerValidationValue("gpt-5"), Args: []string{"--effort", "high"}}
	if !reflect.DeepEqual(created.ResolvedConfiguration, want) || created.StartupResult.State != "pending" {
		t.Fatalf("created: %+v", created)
	}
	if _, err := db.Pool.Exec(ctx, "UPDATE workers SET last_seen_at=statement_timestamp()-interval '1 day' WHERE user_id=$1", principal.UserID); err != nil {
		t.Fatal(err)
	}
	replay, err := bots.CreateResolved(ctx, principal, input)
	if err != nil || !reflect.DeepEqual(created, replay) {
		t.Fatalf("replay changed: %+v %v", replay, err)
	}
	input.Name = "different"
	_, err = bots.CreateResolved(ctx, principal, input)
	requireFault(t, err, "resource_conflict")
	got, err := bots.Get(ctx, principal, created.ID)
	if err != nil || !reflect.DeepEqual(created, got) {
		t.Fatalf("lookup: %+v %v", got, err)
	}
}

func TestBotDefaultsSkipOfflineAutomaticallyButPreserveExplicitWorker(t *testing.T) {
	bots, db, principal, first := botService(t)
	ctx := context.Background()
	second := uuid.NewString()
	reportBotHost(t, db, principal, first, "/first")
	reportBotHost(t, db, principal, second, "/second")
	defaults, err := bots.Defaults(ctx, principal, nil)
	if err != nil || defaults.WorkerID == nil || *defaults.WorkerID != first {
		t.Fatalf("stable first: %+v %v", defaults, err)
	}
	if _, err := db.Pool.Exec(ctx, "UPDATE workers SET last_seen_at=statement_timestamp()-interval '121 seconds' WHERE user_id=$1 AND worker_id=$2", principal.UserID, first); err != nil {
		t.Fatal(err)
	}
	defaults, err = bots.Defaults(ctx, principal, nil)
	if err != nil || defaults.WorkerID == nil || *defaults.WorkerID != second {
		t.Fatalf("fallback: %+v %v", defaults, err)
	}
	defaults, err = bots.Defaults(ctx, principal, &first)
	if err != nil || defaults.WorkerID == nil || *defaults.WorkerID != first || defaults.Configuration != nil || defaults.Reason == nil || *defaults.Reason != "offline" {
		t.Fatalf("explicit: %+v %v", defaults, err)
	}
	_, err = bots.CreateResolved(ctx, principal, CreateBot{ID: uuid.NewString(), Name: "offline", Overrides: model.BotOverrides{WorkerID: &first}})
	requireFault(t, err, "resource_conflict")
}

func TestBotDefaultsWorkerAndProviderSettingsNeverCross(t *testing.T) {
	now := time.Now().UTC()
	first, second := uuid.NewString(), uuid.NewString()
	host := validAssistantHost()
	host.ObservedAt = now
	other := validAssistantHost()
	other.ObservedAt = now
	other.DefaultCwd = "/other"
	other.Providers[0].Args = []string{"--other"}
	input := model.BotDefaultsInput{ObservedAt: now, Workers: []model.WorkerSnapshot{
		{WorkerID: first, LastReportedAt: now, Telemetry: model.WorkerTelemetry{Platform: model.PlatformLinux, AssistantHost: host}},
		{WorkerID: second, LastReportedAt: now, Telemetry: model.WorkerTelemetry{Platform: model.PlatformLinux, AssistantHost: other}},
	}, PreferredWorkerID: &second, WorkerPreferences: map[string]model.BotWorkerPreference{
		first: {Cwd: workerValidationValue("/first-preference"), Provider: workerValidationValue("codex")},
	}}
	result, err := resolveBotDefaults(input, model.BotOverrides{})
	if err != nil || result.Configuration.Cwd != "/other" || result.Configuration.Provider != "copilot" {
		t.Fatalf("cross-worker defaults: %+v %v", result, err)
	}
	result, err = resolveBotDefaults(input, model.BotOverrides{WorkerID: &first})
	if err != nil || result.Configuration.Cwd != "/first-preference" || result.Configuration.Provider != "codex" || result.Configuration.Model != nil || len(result.Configuration.Args) != 0 {
		t.Fatalf("cross-provider defaults: %+v %v", result, err)
	}
	result, err = resolveBotDefaults(input, model.BotOverrides{WorkerID: &second, Provider: workerValidationValue("codex"), Cwd: workerValidationValue("/explicit")})
	if err != nil || result.Configuration.Cwd != "/explicit" || result.Configuration.Model != nil || !reflect.DeepEqual(result.Configuration.Args, []string{"--other"}) {
		t.Fatalf("overrides: %+v %v", result, err)
	}
	unknown := uuid.NewString()
	_, err = resolveBotDefaults(input, model.BotOverrides{WorkerID: &unknown})
	requireFault(t, err, "forbidden")
}

func TestBotDefaultsUnavailableReasonsAndNoInventedProviderFallback(t *testing.T) {
	now := time.Now().UTC()
	for _, tc := range []struct {
		name, reason string
		change       func(*model.WorkerSnapshot, *model.BotOverrides)
	}{
		{"legacy", "unsupported", func(w *model.WorkerSnapshot, o *model.BotOverrides) { w.Telemetry.AssistantHost = nil }},
		{"stale", "stale", func(w *model.WorkerSnapshot, o *model.BotOverrides) {
			w.Telemetry.AssistantHost.ObservedAt = now.Add(-120 * time.Second)
		}},
		{"default failed", "provider_not_found", func(w *model.WorkerSnapshot, o *model.BotOverrides) {
			w.Telemetry.AssistantHost.DefaultProvider = model.AgentClaude
		}},
		{"override failed", "provider_not_found", func(w *model.WorkerSnapshot, o *model.BotOverrides) { o.Provider = workerValidationValue("claude") }},
		{"missing provider", "provider_unavailable", func(w *model.WorkerSnapshot, o *model.BotOverrides) {
			w.Telemetry.AssistantHost.Providers = w.Telemetry.AssistantHost.Providers[:2]
		}},
		{"wrong path platform", "invalid_cwd", func(w *model.WorkerSnapshot, o *model.BotOverrides) { o.Cwd = workerValidationValue(`C:\work`) }},
		{"all failed", "unavailable", func(w *model.WorkerSnapshot, o *model.BotOverrides) {
			for i := range w.Telemetry.AssistantHost.Providers {
				w.Telemetry.AssistantHost.Providers[i].Available = false
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			host := validAssistantHost()
			host.ObservedAt = now
			worker := model.WorkerSnapshot{WorkerID: uuid.NewString(), LastReportedAt: now, Telemetry: model.WorkerTelemetry{Platform: model.PlatformLinux, AssistantHost: host}}
			overrides := model.BotOverrides{WorkerID: &worker.WorkerID}
			tc.change(&worker, &overrides)
			result, err := resolveBotDefaults(model.BotDefaultsInput{ObservedAt: now, Workers: []model.WorkerSnapshot{worker}}, overrides)
			if err != nil || result.Configuration != nil || result.Reason == nil || *result.Reason != tc.reason {
				t.Fatalf("got %+v %v", result, err)
			}
			overrides.WorkerID = nil
			result, err = resolveBotDefaults(model.BotDefaultsInput{ObservedAt: now, Workers: []model.WorkerSnapshot{worker}}, overrides)
			if err != nil || result.WorkerID != nil || *result.Reason != "no_available_worker" {
				t.Fatalf("automatic got %+v %v", result, err)
			}
		})
	}
}

func TestBotDefaultsPendingAndFailedNeverChangeSuccessfulPreferences(t *testing.T) {
	bots, db, principal, worker := botService(t)
	ctx := context.Background()
	other := uuid.NewString()
	reportBotHost(t, db, principal, worker, "/first")
	reportBotHost(t, db, principal, other, "/other")
	create := func(cwd string) model.Bot {
		t.Helper()
		bot, err := bots.CreateResolved(ctx, principal, CreateBot{ID: uuid.NewString(), Name: cwd, Overrides: model.BotOverrides{WorkerID: &other, Cwd: &cwd, Provider: workerValidationValue("codex")}})
		if err != nil {
			t.Fatal(err)
		}
		return bot
	}
	older := create("/older")
	newer := create("/newer")
	defaults, err := bots.Defaults(ctx, principal, nil)
	if err != nil || *defaults.WorkerID != worker {
		t.Fatalf("pending saved preference: %+v %v", defaults, err)
	}
	commit := func(bot model.Bot) {
		t.Helper()
		tx, err := db.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		// The fixture supplies durable readiness to exercise the internal callback;
		// real native identity admission belongs to the lifecycle caller.
		if _, err := tx.Exec(ctx, `UPDATE bots SET session_id=$2,startup_result='{"state":"ready","code":null}' WHERE id=$1`, bot.ID, uuid.NewString()); err != nil {
			t.Fatal(err)
		}
		if err := store.CommitBotPreferences(ctx, tx, bot.ID); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	commit(newer)
	commit(older)
	defaults, err = bots.Defaults(ctx, principal, nil)
	if err != nil || *defaults.WorkerID != other || defaults.Configuration.Cwd != "/newer" || defaults.Configuration.Provider != "codex" {
		t.Fatalf("reordered success: %+v %v", defaults, err)
	}
	failed := create("/failed")
	if _, err := db.Pool.Exec(ctx, `UPDATE bots SET startup_result='{"state":"failed","code":"invalid_cwd"}' WHERE id=$1`, failed.ID); err != nil {
		t.Fatal(err)
	}
	defaults, err = bots.Defaults(ctx, principal, nil)
	if err != nil || defaults.Configuration.Cwd != "/newer" {
		t.Fatalf("failed changed preference: %+v %v", defaults, err)
	}
	selected, err := bots.Defaults(ctx, principal, &worker)
	if err != nil || selected.Configuration.Cwd != "/first" || selected.Configuration.Provider != "copilot" {
		t.Fatalf("settings crossed machines: %+v %v", selected, err)
	}
}

func TestBotDefaultAdmissionAndDatabaseFailures(t *testing.T) {
	bots, db, principal, worker := botService(t)
	ctx := context.Background()
	reportBotHost(t, db, principal, worker, "/ordinary")
	_, err := bots.Defaults(ctx, model.Principal{}, nil)
	requireFault(t, err, "unauthenticated")
	bad := "invalid"
	_, err = bots.Defaults(ctx, principal, &bad)
	requireFault(t, err, "invalid_input")
	stranger := uuid.NewString()
	_, err = bots.Defaults(ctx, principal, &stranger)
	requireFault(t, err, "forbidden")
	_, err = bots.CreateResolved(ctx, principal, CreateBot{ID: uuid.NewString(), Name: "foreign", Overrides: model.BotOverrides{WorkerID: &stranger}})
	requireFault(t, err, "forbidden")
	if _, err := db.Pool.Exec(ctx, "DELETE FROM sessions WHERE id=$1", principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	_, err = bots.Defaults(ctx, principal, nil)
	requireFault(t, err, "unauthenticated")
	db.Close()
	if _, err := bots.Defaults(ctx, principal, nil); err == nil {
		t.Fatal("database failure became defaults")
	}
	if _, err := bots.CreateResolved(ctx, principal, CreateBot{ID: uuid.NewString(), Name: "database failure"}); err == nil {
		t.Fatal("database failure became success")
	}
}

func TestBotResolvedConcurrentRetryObservesWinnerBeforeCheckingAvailability(t *testing.T) {
	bots, db, principal, worker := botService(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	reportBotHost(t, db, principal, worker, "/frozen")
	input, fingerprint, err := normalizeBotRequest(CreateBot{ID: uuid.NewString(), Name: "same identity"})
	if err != nil {
		t.Fatal(err)
	}
	winner, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer winner.Rollback(context.Background())
	if _, err := winner.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('bot-create:' || $1,0))`, input.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := winner.Exec(ctx, `INSERT INTO bots(id,owner_user_id,worker_id,name,request_fingerprint,requested_overrides,resolved_configuration,startup_result)
 VALUES($1,$2,$3,$4,$5,'{}',jsonb_build_object('workerId',$3::uuid::text,'cwd','/frozen','provider','copilot','model',NULL,'args','[]'::jsonb),'{"state":"pending","code":null}')`, input.ID, principal.UserID, worker, input.Name, fingerprint); err != nil {
		t.Fatal(err)
	}
	// The winner already resolved this Worker, but is not yet committed. A
	// concurrent identical request must wait for that identity before resolving.
	if _, err := db.Pool.Exec(ctx, `UPDATE workers SET last_seen_at=statement_timestamp()-interval '1 day' WHERE user_id=$1 AND worker_id=$2`, principal.UserID, worker); err != nil {
		t.Fatal(err)
	}
	type outcome struct {
		bot model.Bot
		err error
	}
	result := make(chan outcome, 1)
	go func() { bot, err := bots.CreateResolved(ctx, principal, input); result <- outcome{bot, err} }()
	threadWait(t, ctx, func() (bool, error) {
		select {
		case got := <-result:
			t.Fatalf("concurrent creation resolved before the original identity: %+v %v", got.bot, got.err)
		default:
		}
		var waiting bool
		err := db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND wait_event_type='Lock' AND query LIKE '%bot-create:%')`).Scan(&waiting)
		return waiting, err
	})
	if err := winner.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-result:
		if got.err != nil || got.bot.ID != input.ID || got.bot.ResolvedConfiguration.Cwd != "/frozen" {
			t.Fatalf("retry lost committed result: %+v %v", got.bot, got.err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}
