package bot

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
)

type creationHistoryRead struct {
	bot model.Bot
	err error
}

type creationHistoryDAO struct {
	store.BotWriteDAO
	t          *testing.T
	ctx        context.Context
	principal  model.Principal
	id         string
	defaults   model.BotDefaultsInput
	reads      []creationHistoryRead
	readCount  int
	wantInsert *model.Bot
	inserts    []model.Bot
	wantCalls  []string
	calls      []string
}

func (d *creationHistoryDAO) record(ctx context.Context, call string) {
	d.t.Helper()
	index := len(d.calls)
	if ctx != d.ctx || index >= len(d.wantCalls) || d.wantCalls[index] != call {
		d.t.Fatalf("unexpected creation call %q: context=%v prior=%v; want %v", call, ctx, d.calls, d.wantCalls)
	}
	d.calls = append(d.calls, call)
}

func (d *creationHistoryDAO) Credential(ctx context.Context, principal model.Principal) error {
	d.t.Helper()
	d.record(ctx, "credential")
	if principal != d.principal {
		d.t.Fatalf("creation principal=%#v; want %#v", principal, d.principal)
	}
	return nil
}

func (d *creationHistoryDAO) LockCreation(ctx context.Context, id string) error {
	d.t.Helper()
	d.record(ctx, "lock")
	if id != d.id {
		d.t.Fatalf("creation lock ID=%q; want %q", id, d.id)
	}
	return nil
}

func (d *creationHistoryDAO) Bot(ctx context.Context, id string) (model.Bot, error) {
	d.t.Helper()
	d.record(ctx, "bot")
	if id != d.id || d.readCount >= len(d.reads) {
		d.t.Fatalf("creation read ID=%q index=%d; want ID=%q reads=%d", id, d.readCount, d.id, len(d.reads))
	}
	fact := d.reads[d.readCount]
	d.readCount++
	return fact.bot, fact.err
}

func (d *creationHistoryDAO) BotPreferredWorker(ctx context.Context, owner string) (*string, error) {
	d.t.Helper()
	d.record(ctx, "preferred")
	if owner != d.principal.UserID {
		d.t.Fatalf("preferred Worker owner=%q; want %q", owner, d.principal.UserID)
	}
	return nil, nil
}

func (d *creationHistoryDAO) BotCreationCandidates(ctx context.Context, owner string) (model.BotDefaultsInput, error) {
	d.t.Helper()
	d.record(ctx, "candidates")
	if owner != d.principal.UserID {
		d.t.Fatalf("creation candidate owner=%q; want %q", owner, d.principal.UserID)
	}
	return d.defaults, nil
}

func (d *creationHistoryDAO) BotCreationWorker(ctx context.Context, owner, worker string) (model.BotDefaultsInput, error) {
	d.t.Helper()
	d.record(ctx, "defaults")
	if owner != d.principal.UserID || worker != workerID {
		d.t.Fatalf("creation defaults owner=%q Worker=%q; want %q %q", owner, worker, d.principal.UserID, workerID)
	}
	return d.defaults, nil
}

func (d *creationHistoryDAO) Worker(ctx context.Context, owner, worker string) error {
	d.t.Helper()
	d.record(ctx, "worker")
	if owner != d.principal.UserID || worker != workerID {
		d.t.Fatalf("creation Worker owner=%q ID=%q; want %q %q", owner, worker, d.principal.UserID, workerID)
	}
	return nil
}

func (d *creationHistoryDAO) InsertBot(ctx context.Context, bot model.Bot) error {
	d.t.Helper()
	d.inserts = append(d.inserts, bot)
	d.record(ctx, "insert")
	if d.wantInsert == nil || !reflect.DeepEqual(bot, *d.wantInsert) {
		d.t.Fatalf("creation insert=%#v; want %#v", bot, d.wantInsert)
	}
	return nil
}

func (d *creationHistoryDAO) verify() {
	d.t.Helper()
	if !reflect.DeepEqual(d.calls, d.wantCalls) || d.readCount != len(d.reads) {
		d.t.Fatalf("creation calls=%v reads=%d; want %v reads=%d", d.calls, d.readCount, d.wantCalls, len(d.reads))
	}
	if d.wantInsert == nil && len(d.inserts) != 0 || d.wantInsert != nil && len(d.inserts) != 1 {
		d.t.Fatalf("creation insertion count=%d; planned insert=%#v", len(d.inserts), d.wantInsert)
	}
}

func TestCreationRejectsNewEffortHistoryWithoutDiscovery(t *testing.T) {
	for _, winner := range []bool{false, true} {
		name := "new history requires discovery"
		if winner {
			name = "original ID wins before new history"
		}
		t.Run(name, func(t *testing.T) {
			ctx := t.Context()
			principal := model.Principal{Kind: model.SessionCredential, UserID: "df339d36-1b78-46c2-88ce-52f80a95a8fb", CredentialID: "5f381f81-c874-480d-a31a-663c5d5123c9"}
			now := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
			worker := model.WorkerSnapshot{WorkerID: workerID, LastReportedAt: now, Telemetry: model.WorkerTelemetry{Platform: model.PlatformLinux, AssistantHost: &model.WorkerAssistantHost{ProtocolVersion: 1, ObservedAt: now.Add(-time.Second), CreationConfigurationVersion: 1, DefaultCwd: "/workspace", DefaultProvider: model.AgentCodex, Providers: []model.WorkerAssistantProvider{{Provider: model.AgentCodex, Available: true, Args: []string{}}}}}}
			earlier := model.BotDefaultsInput{ObservedAt: now, Workers: []model.WorkerSnapshot{worker}}
			current := earlier
			preference := model.BotNativePreference{Efforts: map[string]string{"model-a": "low"}}
			current.WorkerPreferences = map[string]model.BotWorkerPreference{workerID: {Native: map[string]model.BotNativePreference{"codex": preference}}}
			input, fingerprint, err := NormalizeBotRequest(CreateBot{ID: botID, Name: "Native model"})
			if err != nil {
				t.Fatal(err)
			}
			snapshot := &creationHistoryDAO{t: t, ctx: ctx, principal: principal, id: input.ID, defaults: earlier, wantCalls: []string{"preferred", "candidates", "defaults"}}
			observed, resolved, err := CreationDefaults(ctx, snapshot, principal.UserID, input.Overrides)
			snapshot.verify()
			initial := model.BotConfiguration{WorkerID: workerID, Cwd: "/workspace", Provider: "codex", Args: []string{}, Selection: &model.BotSelection{SchemaVersion: 1, ModelSource: "native", ReasoningEffortSource: "native"}}
			if err != nil || !reflect.DeepEqual(observed, earlier) || !reflect.DeepEqual(resolved.Configuration, &initial) || RequiresNativeDiscovery(initial, model.BotNativePreference{}) {
				t.Fatalf("initial name-only observation: %#v %v", resolved, err)
			}
			input.ResolvedConfiguration = *resolved.Configuration
			proposed := model.Bot{ID: input.ID, OwnerUserID: principal.UserID, WorkerID: workerID, Name: input.Name, RequestFingerprint: fingerprint, RequestedOverrides: input.Overrides, ResolvedConfiguration: initial}
			frozen := proposed
			frozen.Version, frozen.CreationOrder = 1, 23
			frozen.CreatedAt, frozen.UpdatedAt = now, now
			frozen.StartupResult = model.BotStartupResult{State: "pending"}
			if winner {
				first := &creationHistoryDAO{t: t, ctx: ctx, principal: principal, id: input.ID, defaults: earlier, reads: []creationHistoryRead{{err: model.ErrNotFound}, {bot: frozen}}, wantInsert: &proposed, wantCalls: []string{"credential", "lock", "bot", "preferred", "candidates", "defaults", "worker", "insert", "bot", "credential"}}
				committed, err := Create(ctx, first, principal, input, fingerprint, true)
				first.verify()
				if err != nil || !reflect.DeepEqual(committed, frozen) {
					t.Fatalf("original creation: %#v %v; want %#v", committed, err, frozen)
				}
				replay := &creationHistoryDAO{t: t, ctx: ctx, principal: principal, id: input.ID, defaults: current, reads: []creationHistoryRead{{bot: frozen}}, wantCalls: []string{"credential", "lock", "bot", "credential"}}
				created, err := Create(ctx, replay, principal, input, fingerprint, true)
				replay.verify()
				if err != nil || !reflect.DeepEqual(created, frozen) || !reflect.DeepEqual(created, committed) || created.ResolvedConfiguration.ReasoningEffort != nil || len(replay.inserts) != 0 {
					t.Fatalf("original ID lost frozen result to new history: %#v %v", created, err)
				}
				return
			}
			stale := &creationHistoryDAO{t: t, ctx: ctx, principal: principal, id: input.ID, defaults: current, reads: []creationHistoryRead{{err: model.ErrNotFound}}, wantCalls: []string{"credential", "lock", "bot", "preferred", "candidates", "defaults"}}
			created, err := Create(ctx, stale, principal, input, fingerprint, true)
			assertFault(t, err, "resource_conflict")
			stale.verify()
			if !reflect.DeepEqual(created, model.Bot{}) || len(stale.inserts) != 0 {
				t.Fatalf("undiscovered history created a Bot: %#v inserts=%#v", created, stale.inserts)
			}
			fresh := &creationHistoryDAO{t: t, ctx: ctx, principal: principal, id: input.ID, defaults: current, wantCalls: []string{"preferred", "candidates", "defaults"}}
			freshFacts, freshDefaults, err := CreationDefaults(ctx, fresh, principal.UserID, input.Overrides)
			fresh.verify()
			freshPreference := freshFacts.WorkerPreferences[workerID].Native["codex"]
			if err != nil || !reflect.DeepEqual(freshFacts, current) || !reflect.DeepEqual(freshPreference, preference) || freshDefaults.Configuration == nil || !RequiresNativeDiscovery(*freshDefaults.Configuration, freshPreference) {
				t.Fatalf("new history did not require rediscovery: %#v %v", freshDefaults, err)
			}
			baseline, err := WorkerNativeDefaults(freshFacts, input.Overrides, workerID)
			if err != nil || !reflect.DeepEqual(baseline, initial) {
				t.Fatalf("rediscovery Worker baseline: %#v %v", baseline, err)
			}
			catalog := ro.ModelResult{SchemaVersion: 1, Provider: "codex", Cwd: "/workspace", ConfigurationGeneration: strings.Repeat("a", 64), CatalogGeneration: "ca62d2bb-d4bf-47b8-93bd-d57e5a7fcefd", Models: []ro.ModelOption{{ID: "model-a", Label: "Model A", Aliases: []string{}, ReasoningEfforts: []string{"low", "high"}, DefaultReasoningEffort: ptr("high")}, {ID: "model-b", Label: "Model B", Aliases: []string{}, ReasoningEfforts: []string{"low", "high"}, DefaultReasoningEffort: ptr("low")}}, Defaults: ro.ModelDefaults{Model: ro.ModelDefault{Value: ptr("model-a"), Source: "native"}, ReasoningEffort: ro.ModelDefault{Value: ptr("high"), Source: "cloud"}}}
			discovered, err := ResolveNativeSelection(*freshDefaults.Configuration, input.Overrides, freshPreference, catalog, nil)
			selected := model.BotConfiguration{WorkerID: workerID, Cwd: "/workspace", Provider: "codex", Model: ptr("model-a"), Args: []string{}, ReasoningEffort: ptr("low"), Selection: &model.BotSelection{SchemaVersion: 1, ModelSource: "native", ReasoningEffortSource: "preference", ConfigurationGeneration: catalog.ConfigurationGeneration, CatalogGeneration: catalog.CatalogGeneration}}
			if err != nil || !reflect.DeepEqual(discovered, selected) {
				t.Fatalf("rediscovered selection: %#v %v; want %#v", discovered, err, selected)
			}
			input.Resolution = &CreationResolution{Expected: *freshDefaults.Configuration, ExpectedBaseline: baseline, ExpectedPreference: freshPreference, Configuration: discovered}
			proposed.ResolvedConfiguration = selected
			frozen.ResolvedConfiguration = selected
			retry := &creationHistoryDAO{t: t, ctx: ctx, principal: principal, id: input.ID, defaults: current, reads: []creationHistoryRead{{err: model.ErrNotFound}, {bot: frozen}}, wantInsert: &proposed, wantCalls: []string{"credential", "lock", "bot", "preferred", "candidates", "defaults", "worker", "insert", "bot", "credential"}}
			created, err = Create(ctx, retry, principal, input, fingerprint, true)
			retry.verify()
			if err != nil || !reflect.DeepEqual(created, frozen) || created.ID != input.ID || created.ResolvedConfiguration.ReasoningEffort == nil || *created.ResolvedConfiguration.ReasoningEffort != "low" || created.ResolvedConfiguration.Selection.ReasoningEffortSource != "preference" {
				t.Fatalf("fresh original-ID request lost discovered history: %#v %v; want %#v", created, err, frozen)
			}
		})
	}
}
