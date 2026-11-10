package bot

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	"github.com/google/uuid"
)

type modelRequestFunc func(context.Context, model.Principal, string, ro.Request) (ro.Message, error)

func (f modelRequestFunc) Request(ctx context.Context, p model.Principal, w string, r ro.Request) (ro.Message, error) {
	return f(ctx, p, w, r)
}
func nativeResponse(p model.Principal, worker string, request ro.Request) ro.Message {
	var input ro.ModelInput
	_ = json.Unmarshal(request.Input, &input)
	selected := input.Model
	source := "explicit"
	if selected == nil {
		selected = pointer("model-a")
		source = "native"
	}
	catalog := ro.ModelResult{SchemaVersion: 1, Provider: input.Provider, Cwd: *input.Cwd, ConfigurationGeneration: strings.Repeat("a", 64), CatalogGeneration: "ca62d2bb-d4bf-47b8-93bd-d57e5a7fcefd",
		Models:   []ro.ModelOption{{ID: "model-a", Label: "Model A", Aliases: []string{}, ReasoningEfforts: []string{"low", "high"}, DefaultReasoningEffort: pointer("high")}, {ID: "model-b", Label: "Model B", Aliases: []string{}, ReasoningEfforts: []string{"low", "high"}, DefaultReasoningEffort: pointer("low")}},
		Defaults: ro.ModelDefaults{Model: ro.ModelDefault{Value: selected, Source: source}, ReasoningEffort: ro.ModelDefault{Value: pointer("high"), Source: "cloud"}}}
	raw, _ := json.Marshal(catalog)
	return ro.Message{Fence: ro.Fence{Protocol: ro.Protocol, OwnerUserID: p.UserID, WorkerID: worker, ConnectionID: "d9ae323c-8ab9-43f1-99d4-85d006de9c58", CapabilityGeneration: "43221814-a769-42c8-91ec-11d3c5907adf"}, Type: "result", RequestID: request.RequestID, Result: raw}
}
func nativeBase(worker string) model.BotConfiguration {
	return model.BotConfiguration{WorkerID: worker, Cwd: "/work", Provider: "codex", Model: pointer("model-a"), Args: []string{"--ordinary"}, Selection: &model.BotSelection{SchemaVersion: 1, ModelSource: "explicit", ReasoningEffortSource: "native"}}
}
func TestCreationDiscoveryCompletesSnapshotBeforeNetworkAndWrite(t *testing.T) {
	for _, kind := range []string{"name only", "explicit model", "explicit effort", "both", "stale", "winner after discovery failure", "new history without discovery"} {
		t.Run(kind, func(t *testing.T) {
			discover := kind != "name only" && kind != "new history without discovery"
			names := []string{"snapshot", "get", "defaults", "read_done"}
			if discover {
				names = append(names, "baseline", "network", "selection")
			}
			names = append(names, "write", "create", "write_done")
			if kind == "winner after discovery failure" {
				names = []string{"snapshot", "get", "defaults", "read_done", "baseline", "network", "write", "create", "write_done"}
			}
			f := newBotFixture(t, names...)
			worker := uuid.NewString()
			base := nativeBase(worker)
			if !discover {
				base.Selection.ModelSource = "native"
				base.Model = nil
			}
			if kind == "explicit effort" {
				base.Model = nil
				base.Selection.ModelSource = "native"
				base.Selection.ReasoningEffortSource = "explicit"
				base.ReasoningEffort = pointer("low")
			}
			overrides := model.BotOverrides{}
			if kind == "explicit model" || kind == "both" || kind == "stale" || kind == "winner after discovery failure" {
				overrides.Model = pointer("model-a")
			}
			if kind == "explicit effort" || kind == "both" {
				overrides.ReasoningEffort = pointer("low")
			}
			in := botcore.CreateBot{ID: uuid.NewString(), Name: " Native ", Overrides: overrides}
			defaults := model.BotDefaultsInput{ObservedAt: time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC), WorkerPreferences: map[string]model.BotWorkerPreference{worker: {Native: map[string]model.BotNativePreference{base.Provider: {}}}}}
			final := base
			final.ReasoningEffort = pointer("low")
			snapshotClosed := false
			f.service.operations.get = func(ctx context.Context, s store.SnapshotScope, p model.Principal, id string) (model.Bot, error) {
				f.plan.call("get")
				identical(t, ctx, f.ctx)
				identical(t, s, f.snapshot)
				same(t, p, f.p)
				same(t, id, in.ID)
				return model.Bot{}, &model.Fault{Code: "not_found", Message: "missing"}
			}
			f.service.operations.creationDefaults = func(ctx context.Context, d store.BotCreationReader, owner string, o model.BotOverrides) (model.BotDefaultsInput, botcore.BotDefaults, error) {
				f.plan.call("defaults")
				identical(t, ctx, f.ctx)
				identical(t, d, f.snapshot.reader)
				same(t, owner, f.p.UserID)
				same(t, o, overrides)
				snapshotClosed = true
				return defaults, botcore.BotDefaults{Configuration: &base}, nil
			}
			f.service.operations.workerDefaults = func(d model.BotDefaultsInput, o model.BotOverrides, w string) (model.BotConfiguration, error) {
				f.plan.call("baseline")
				same(t, d, defaults)
				same(t, o, overrides)
				same(t, w, worker)
				return base, nil
			}
			lost := errors.New("discovery connection lost")
			f.service.models = modelRequestFunc(func(ctx context.Context, p model.Principal, w string, r ro.Request) (ro.Message, error) {
				f.plan.call("network")
				if !snapshotClosed {
					t.Fatal("snapshot callback still open")
				}
				same(t, p, f.p)
				same(t, w, worker)
				if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > 31*time.Second {
					t.Fatal("missing discovery deadline")
				}
				if ctx.Value(struct{}{}) != "caller" {
					t.Fatal("lost caller context")
				}
				if kind == "winner after discovery failure" {
					return ro.Message{}, lost
				}
				return nativeResponse(p, w, r), nil
			})
			f.service.operations.nativeSelection = func(b model.BotConfiguration, o model.BotOverrides, p model.BotNativePreference, c ro.ModelResult, selected *string) (model.BotConfiguration, error) {
				f.plan.call("selection")
				same(t, b, base)
				same(t, o, overrides)
				same(t, p, model.BotNativePreference{})
				same(t, c.Provider, base.Provider)
				return final, nil
			}
			var lowerError error
			if kind == "stale" || kind == "new history without discovery" {
				lowerError = &model.Fault{Code: "resource_conflict", Message: "selection changed"}
				f.completion = store.TransactionNotCommitted
				f.writeCallbackError = lowerError
			}
			expected := frozenBot(f.p, botInput(worker))
			expected.ID = in.ID
			f.service.operations.create = func(ctx context.Context, d store.BotWriteDAO, p model.Principal, v botcore.CreateBot, fp string, resolve bool) (model.Bot, error) {
				f.plan.call("create")
				identical(t, ctx, f.ctx)
				identical(t, d, f.write.dao)
				same(t, p, f.p)
				same(t, v.ID, in.ID)
				same(t, v.Name, "Native")
				same(t, v.Overrides, overrides)
				if !resolve || len(fp) != 64 {
					t.Fatal("lost resolved request identity")
				}
				if kind == "winner after discovery failure" {
					same(t, v.ResolutionError, lost)
					same(t, v.Resolution, (*botcore.CreationResolution)(nil))
				} else if discover {
					same(t, v.Resolution, &botcore.CreationResolution{Expected: base, ExpectedBaseline: base, ExpectedPreference: model.BotNativePreference{}, Configuration: final})
					same(t, v.ResolutionError, nil)
				} else {
					same(t, v.Resolution, (*botcore.CreationResolution)(nil))
				}
				return expected, lowerError
			}
			got, err := f.service.CreateResolved(f.ctx, f.p, in)
			if lowerError != nil {
				same(t, got, model.Bot{})
				same(t, err, lowerError)
			} else {
				if err != nil {
					t.Fatal(err)
				}
				same(t, got, expected)
			}
		})
	}
}
func TestCreationSnapshotPreservesReadAndCleanupErrors(t *testing.T) {
	fault := &model.Fault{Code: "active_worker_limit_exceeded", Message: "limit"}
	sentinel := errors.New("database failure")
	for _, kind := range []string{"joined read", "snapshot cleanup", "get error", "no configuration", "selection refusal"} {
		t.Run(kind, func(t *testing.T) {
			names := []string{"snapshot", "get", "defaults", "read_done"}
			if kind == "get error" {
				names = []string{"snapshot", "get", "read_done"}
			}
			f := newBotFixture(t, names...)
			read := error(fault)
			if kind == "joined read" {
				read = errors.Join(fault, sentinel)
				f.readCallbackError = read
			}
			if kind == "snapshot cleanup" {
				f.readFinishError = sentinel
			}
			if kind == "no configuration" {
				read = nil
			}
			if kind == "get error" {
				f.readCallbackError = sentinel
			}
			f.service.operations.get = func(ctx context.Context, s store.SnapshotScope, p model.Principal, id string) (model.Bot, error) {
				f.plan.call("get")
				identical(t, ctx, f.ctx)
				identical(t, s, f.snapshot)
				if kind == "get error" {
					return model.Bot{}, sentinel
				}
				return model.Bot{}, &model.Fault{Code: "not_found", Message: "missing"}
			}
			f.service.operations.creationDefaults = func(ctx context.Context, d store.BotCreationReader, owner string, o model.BotOverrides) (model.BotDefaultsInput, botcore.BotDefaults, error) {
				f.plan.call("defaults")
				identical(t, d, f.snapshot.reader)
				same(t, owner, f.p.UserID)
				return model.BotDefaultsInput{}, botcore.BotDefaults{}, read
			}
			got, err := f.service.prepareCreation(f.ctx, f.p, botcore.CreateBot{ID: uuid.NewString()})
			same(t, got, (*botcore.CreationResolution)(nil))
			if kind == "no configuration" {
				same(t, err, nil)
			} else if kind == "selection refusal" {
				same(t, err, fault)
			} else {
				if !errors.Is(err, sentinel) {
					t.Fatalf("lost cause %v", err)
				}
				if kind != "get error" && !errors.Is(err, fault) {
					t.Fatalf("lost refusal %v", err)
				}
			}
		})
	}
}
func TestNativeCatalogPaginationAndStalePreferenceFallback(t *testing.T) {
	p := testPrincipal()
	base := nativeBase(uuid.NewString())
	base.Model = pointer("retired")
	base.Selection.ModelSource = "preference"
	requests := []*string{}
	expected := base
	expected.Model = pointer("model-a")
	expected.ReasoningEffort = pointer("high")
	plan := newPlan(t, "network", "selection")
	bots := NewWithNativeDiscovery(nil, modelRequestFunc(func(ctx context.Context, actor model.Principal, w string, r ro.Request) (ro.Message, error) {
		plan.call("network")
		same(t, actor, p)
		same(t, w, base.WorkerID)
		var in ro.ModelInput
		if e := json.Unmarshal(r.Input, &in); e != nil {
			t.Fatal(e)
		}
		requests = append(requests, in.Model)
		same(t, in.Model, (*string)(nil))
		same(t, in.IncludeHidden, pointer(true))
		same(t, in.Limit, pointer(100))
		same(t, in.Cwd, &base.Cwd)
		return nativeResponse(actor, w, r), nil
	}))
	bots.operations = botOperations{nativeSelection: func(b model.BotConfiguration, o model.BotOverrides, preference model.BotNativePreference, c ro.ModelResult, selected *string) (model.BotConfiguration, error) {
		plan.call("selection")
		same(t, b, base)
		same(t, selected, (*string)(nil))
		return expected, nil
	}}
	got, err := bots.resolveNative(t.Context(), p, base, model.BotOverrides{}, model.BotNativePreference{Model: pointer("retired"), Efforts: map[string]string{"model-a": "retired"}}, base)
	if err != nil {
		t.Fatal(err)
	}
	same(t, got, expected)
	same(t, len(requests), 1)
	for _, kind := range []string{"catalog", "defaults", "cursor", "identity", "error"} {
		t.Run(kind, func(t *testing.T) {
			calls := 0
			bots.models = modelRequestFunc(func(ctx context.Context, p model.Principal, w string, r ro.Request) (ro.Message, error) {
				calls++
				if calls > 2 {
					t.Fatal("unbounded catalog retries")
				}
				message := nativeResponse(p, w, r)
				var c ro.ModelResult
				if e := json.Unmarshal(message.Result, &c); e != nil {
					t.Fatal(e)
				}
				c.NextCursor = pointer("next")
				if calls > 1 {
					switch kind {
					case "catalog":
						c.CatalogGeneration = uuid.NewString()
					case "defaults":
						c.Defaults.ReasoningEffort.Value = pointer("low")
					case "identity":
						message.WorkerID = uuid.NewString()
					case "error":
						message.Result = nil
						message.Error = &ro.Error{Code: "cleanup_unknown", Message: "cleanup unconfirmed"}
						return message, nil
					}
				}
				message.Result, _ = json.Marshal(c)
				return message, nil
			})
			_, e := bots.readModels(t.Context(), p, base, nil)
			if e == nil || calls != 2 {
				t.Fatalf("accepted inconsistent catalog: calls=%d err=%v", calls, e)
			}
		})
	}
}
func TestHistoricalEffortDoesNotBlockNameOnlyUnknownNativeDefault(t *testing.T) {
	p := model.Principal{UserID: uuid.NewString()}
	worker := uuid.NewString()
	base := model.BotConfiguration{WorkerID: worker, Cwd: "/work", Provider: "copilot", Args: []string{}, Selection: &model.BotSelection{SchemaVersion: 1, ModelSource: "native", ReasoningEffortSource: "native"}}
	preference := model.BotNativePreference{Efforts: map[string]string{"model-a": "high"}}
	var observedEffort *string
	observedEffortSource := "unknown"
	bots := &Bots{operations: botOperations{nativeSelection: func(model.BotConfiguration, model.BotOverrides, model.BotNativePreference, ro.ModelResult, *string) (model.BotConfiguration, error) {
		return model.BotConfiguration{}, nativeFailure("unknown_default", "Native model is unknown")
	}}, models: modelRequestFunc(func(ctx context.Context, p model.Principal, w string, r ro.Request) (ro.Message, error) {
		message := nativeResponse(p, w, r)
		var catalog ro.ModelResult
		_ = json.Unmarshal(message.Result, &catalog)
		catalog.Defaults = ro.ModelDefaults{Model: ro.ModelDefault{Source: "unknown"}, ReasoningEffort: ro.ModelDefault{Value: observedEffort, Source: observedEffortSource}}
		catalog.SelectionError = &ro.Error{Code: "unknown_default", Message: "Native model is unknown"}
		message.Result, _ = json.Marshal(catalog)
		return message, nil
	})}
	got, err := bots.resolveNative(context.Background(), p, base, model.BotOverrides{}, preference, base)
	if err != nil || got.Model != nil || got.ReasoningEffort != nil || got.Selection.ModelSource != "native" {
		t.Fatalf("history blocked name-only native delegation: %+v %v", got, err)
	}
	observedEffort = pointer("high")
	observedEffortSource = "local"
	_, err = bots.resolveNative(context.Background(), p, base, model.BotOverrides{}, preference, base)
	requireFault(t, err, "unknown_default")
	observedEffort = nil
	observedEffortSource = "unknown"
	retired := base
	retired.Model = pointer("retired")
	selection := *base.Selection
	retired.Selection = &selection
	retired.Selection.ModelSource = "preference"
	preference.Model = pointer("retired")
	got, err = bots.resolveNative(context.Background(), p, retired, model.BotOverrides{}, preference, base)
	if err != nil || got.Model != nil || got.Selection.ModelSource != "native" {
		t.Fatalf("retired model blocked native delegation: %+v %v", got, err)
	}
	_, err = bots.resolveNative(context.Background(), p, base, model.BotOverrides{ReasoningEffort: pointer("high")}, preference, base)
	requireFault(t, err, "unknown_default")
	base.ReasoningEffort = pointer("high")
	base.Selection.ReasoningEffortSource = "cloud"
	_, err = bots.resolveNative(context.Background(), p, base, model.BotOverrides{}, preference, base)
	requireFault(t, err, "unknown_default")
	bots.models = modelRequestFunc(func(context.Context, model.Principal, string, ro.Request) (ro.Message, error) {
		return ro.Message{}, nativeFailure("cleanup_unknown", "Unconfirmed cleanup")
	})
	_, err = bots.resolveNative(context.Background(), p, base, model.BotOverrides{}, preference, base)
	requireFault(t, err, "cleanup_unknown")
}
