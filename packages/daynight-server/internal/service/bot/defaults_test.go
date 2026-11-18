package bot

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	"github.com/google/uuid"
)

type defaultsReader struct {
	store.BotReader
	read func(context.Context, string) (model.BotDefaultsInput, error)
}

func (d *defaultsReader) BotDefaults(ctx context.Context, owner string) (model.BotDefaultsInput, error) {
	return d.read(ctx, owner)
}

type defaultsCredential struct {
	read func(context.Context, model.Principal) (store.ThreadCredential, error)
}

func (d *defaultsCredential) Credential(ctx context.Context, p model.Principal) (store.ThreadCredential, error) {
	return d.read(ctx, p)
}

func TestDefaultsForwardsRawFactsAndPublishesNativePreviewOnlyAfterRead(t *testing.T) {
	for _, discover := range []bool{false, true} {
		t.Run(map[bool]string{false: "name only", true: "explicit native preview"}[discover], func(t *testing.T) {
			names := []string{"snapshot", "credential", "defaults", "read_done", "resolve"}
			if discover {
				names = append(names, "baseline", "network", "selection")
			}
			f := newBotFixture(t, names...)
			worker := uuid.NewString()
			base := nativeBase(worker)
			if !discover {
				base.Model = nil
				base.Selection.ModelSource = "native"
			}
			overrides := model.BotOverrides{WorkerID: pointer(strings.ToUpper(worker))}
			normalized := overrides
			normalized.WorkerID = &worker
			if discover {
				overrides.Model = pointer("model-b")
				overrides.ReasoningEffort = pointer("low")
				normalized.Model = overrides.Model
				normalized.ReasoningEffort = overrides.ReasoningEffort
			}
			otherWorker := uuid.NewString()
			observedAt := time.Date(2026, 11, 18, 12, 0, 0, 123456000, time.UTC)
			input := model.BotDefaultsInput{
				ObservedAt:        observedAt,
				Workers:           []model.WorkerSnapshot{{WorkerID: otherWorker, LastReportedAt: observedAt.Add(-time.Second)}, {WorkerID: worker, LastReportedAt: observedAt}},
				PreferredWorkerID: &worker,
				WorkerPreferences: map[string]model.BotWorkerPreference{worker: {Cwd: pointer("/remembered"), Provider: pointer(base.Provider), Native: map[string]model.BotNativePreference{base.Provider: {}}}},
			}
			f.snapshot.credential = &defaultsCredential{read: func(ctx context.Context, p model.Principal) (store.ThreadCredential, error) {
				f.plan.call("credential")
				identical(t, ctx, f.ctx)
				same(t, p, f.p)
				return store.ThreadCredential{}, nil
			}}
			f.snapshot.reader = &defaultsReader{read: func(ctx context.Context, owner string) (model.BotDefaultsInput, error) {
				f.plan.call("defaults")
				identical(t, ctx, f.ctx)
				same(t, owner, f.p.UserID)
				return input, nil
			}}
			f.service.operations.defaults = func(v model.BotDefaultsInput, o model.BotOverrides) (botcore.BotDefaults, error) {
				f.plan.call("resolve")
				same(t, v, input)
				same(t, o, normalized)
				return botcore.BotDefaults{ObservedAt: observedAt, Configuration: &base, WorkerID: &worker, Workers: []botcore.BotWorkerDefaults{
					{WorkerID: otherWorker}, {WorkerID: worker, Configuration: &base},
				}}, nil
			}
			f.service.operations.workerDefaults = func(v model.BotDefaultsInput, o model.BotOverrides, w string) (model.BotConfiguration, error) {
				f.plan.call("baseline")
				same(t, v, input)
				same(t, o, normalized)
				same(t, w, worker)
				return base, nil
			}
			f.service.models = modelRequestFunc(func(ctx context.Context, p model.Principal, w string, r ro.Request) (ro.Message, error) {
				f.plan.call("network")
				same(t, p, f.p)
				same(t, w, worker)
				return nativeResponse(p, w, r), nil
			})
			final := base
			final.Model = pointer("model-b")
			final.ReasoningEffort = pointer("low")
			f.service.operations.nativeSelection = func(b model.BotConfiguration, o model.BotOverrides, p model.BotNativePreference, c ro.ModelResult, selected *string) (model.BotConfiguration, error) {
				f.plan.call("selection")
				same(t, b, base)
				same(t, o, normalized)
				same(t, p, model.BotNativePreference{})
				same(t, selected, base.Model)
				return final, nil
			}
			got, e := f.service.DefaultsFor(f.ctx, f.p, overrides)
			if e != nil {
				t.Fatal(e)
			}
			want := base
			if discover {
				want = final
			}
			same(t, got.ObservedAt, observedAt)
			same(t, got.Configuration, &want)
			same(t, got.Workers, []botcore.BotWorkerDefaults{{WorkerID: otherWorker}, {WorkerID: worker, Configuration: &want}})
		})
	}
}
func TestDefaultsForResolvesObservedWorkerCandidates(t *testing.T) {
	const legacyID = "11111111-1111-4111-8111-111111111111"
	const usableID = "abcdef01-2222-4222-8222-222222222222"
	observedAt := time.Date(2026, 11, 18, 12, 0, 0, 123456000, time.UTC)
	machine := model.WorkerMachine{ID: "33333333-3333-4333-8333-333333333333", Name: "Assistant host"}
	for _, tc := range []struct {
		name    string
		offline bool
	}{
		{name: "automatic"},
		{name: "explicit offline", offline: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newBotFixture(t, "snapshot", "credential", "defaults", "read_done", "resolve")
			reportedAt := observedAt
			var overrides, normalized model.BotOverrides
			wantState := "available"
			if tc.offline {
				reportedAt = observedAt.Add(-10 * time.Minute)
				overrides.WorkerID = pointer(strings.ToUpper(usableID))
				normalized.WorkerID = pointer(usableID)
				wantState = "offline"
			}
			newInput := func() model.BotDefaultsInput {
				return model.BotDefaultsInput{ObservedAt: observedAt, Workers: []model.WorkerSnapshot{
					{WorkerID: legacyID, LastReportedAt: observedAt.Add(-time.Second), Telemetry: model.WorkerTelemetry{Platform: model.PlatformLinux}},
					{WorkerID: usableID, LastReportedAt: reportedAt, Telemetry: model.WorkerTelemetry{
						Machine: machine, Platform: model.PlatformLinux,
						AssistantHost: &model.WorkerAssistantHost{ProtocolVersion: 1, ObservedAt: observedAt, DefaultCwd: "/workspace", DefaultProvider: model.AgentCopilot, Providers: []model.WorkerAssistantProvider{
							{Provider: model.AgentCodex, Available: true, Args: []string{}},
							{Provider: model.AgentClaude, Reason: pointer("not_found"), Args: []string{}},
							{Provider: model.AgentCopilot, Available: true, Model: pointer("gpt-5"), Args: []string{"--effort", "high"}},
						}},
					}},
				}}
			}
			f.snapshot.credential = &defaultsCredential{read: func(ctx context.Context, principal model.Principal) (store.ThreadCredential, error) {
				f.plan.call("credential")
				identical(t, ctx, f.ctx)
				same(t, principal, f.p)
				return store.ThreadCredential{}, nil
			}}
			f.snapshot.reader = &defaultsReader{read: func(ctx context.Context, owner string) (model.BotDefaultsInput, error) {
				f.plan.call("defaults")
				identical(t, ctx, f.ctx)
				same(t, owner, f.p.UserID)
				return newInput(), nil
			}}
			f.service.operations.defaults = func(input model.BotDefaultsInput, choices model.BotOverrides) (botcore.BotDefaults, error) {
				f.plan.call("resolve")
				want := newInput()
				if !input.ObservedAt.Equal(want.ObservedAt) {
					t.Fatalf("defaults resolver lost the DAO observation time: got %v, want %v", input.ObservedAt, want.ObservedAt)
				}
				if !reflect.DeepEqual(input.Workers, want.Workers) {
					t.Fatalf("defaults resolver lost the DAO Worker rows: got %#v, want %#v", input.Workers, want.Workers)
				}
				same(t, input, want)
				same(t, choices, normalized)
				return botcore.ResolveBotDefaults(input, choices)
			}
			f.service.models = modelRequestFunc(func(context.Context, model.Principal, string, ro.Request) (ro.Message, error) {
				t.Fatal("ordinary defaults unexpectedly requested native discovery")
				return ro.Message{}, nil
			})

			got, err := f.service.DefaultsFor(f.ctx, f.p, overrides)
			if err != nil {
				t.Fatal(err)
			}
			if !got.ObservedAt.Equal(observedAt) || len(got.Workers) != 2 || got.Workers[0].WorkerID != legacyID || got.Workers[1].WorkerID != usableID {
				t.Fatalf("defaults result lost observed Worker order or time: %+v", got)
			}
			legacy, selected := got.Workers[0], got.Workers[1]
			if legacy.State != "unsupported" || legacy.Providers == nil || len(legacy.Providers) != 0 || legacy.Configuration != nil ||
				selected.State != wantState || len(selected.Providers) != 3 || selected.Machine != machine || selected.Platform != model.PlatformLinux {
				t.Fatalf("defaults result lost Worker facts: %+v", got.Workers)
			}
			same(t, got.WorkerID, pointer(usableID))
			same(t, got.Configuration, selected.Configuration)
			if tc.offline {
				same(t, got.Reason, pointer("offline"))
				same(t, got.Configuration, (*model.BotConfiguration)(nil))
				return
			}
			config := got.Configuration
			if got.Reason != nil || config == nil || config.WorkerID != usableID || config.Cwd != "/workspace" ||
				config.Provider != "copilot" || config.Model == nil || *config.Model != "gpt-5" || !slices.Equal(config.Args, []string{"--effort", "high"}) {
				t.Fatalf("automatic defaults lost the usable Worker's configuration: %+v", got)
			}
		})
	}
}

func TestDefaultsShortCircuitsFailuresAndPreservesCause(t *testing.T) {
	for _, stage := range []string{"credential missing", "credential storage", "defaults storage", "snapshot", "resolution", "unavailable", "baseline", "network", "selection"} {
		t.Run(stage, func(t *testing.T) {
			names := []string{"snapshot", "credential"}
			if !strings.HasPrefix(stage, "credential") {
				names = append(names, "defaults")
			}
			names = append(names, "read_done")
			if stage != "snapshot" && !strings.HasPrefix(stage, "credential") && stage != "defaults storage" {
				names = append(names, "resolve")
			}
			if stage == "baseline" || stage == "network" || stage == "selection" {
				names = append(names, "baseline")
			}
			if stage == "network" || stage == "selection" {
				names = append(names, "network")
			}
			if stage == "selection" {
				names = append(names, "selection")
			}
			f := newBotFixture(t, names...)
			cause := errors.New(stage)
			base := nativeBase(uuid.NewString())
			input := model.BotDefaultsInput{}
			if stage == "snapshot" {
				f.readFinishError = cause
			}
			if stage == "credential missing" {
				f.readCallbackError = model.Unauthenticated(model.ErrNotFound)
			} else if strings.HasPrefix(stage, "credential") || stage == "defaults storage" {
				f.readCallbackError = cause
			}
			f.snapshot.credential = &defaultsCredential{read: func(ctx context.Context, p model.Principal) (store.ThreadCredential, error) {
				f.plan.call("credential")
				identical(t, ctx, f.ctx)
				same(t, p, f.p)
				if stage == "credential missing" {
					return store.ThreadCredential{}, model.ErrNotFound
				}
				if stage == "credential storage" {
					return store.ThreadCredential{}, cause
				}
				return store.ThreadCredential{}, nil
			}}
			f.snapshot.reader = &defaultsReader{read: func(ctx context.Context, owner string) (model.BotDefaultsInput, error) {
				f.plan.call("defaults")
				identical(t, ctx, f.ctx)
				same(t, owner, f.p.UserID)
				if stage == "defaults storage" {
					return input, cause
				}
				return input, nil
			}}
			f.service.operations.defaults = func(v model.BotDefaultsInput, o model.BotOverrides) (botcore.BotDefaults, error) {
				f.plan.call("resolve")
				same(t, v, input)
				if stage == "resolution" {
					return botcore.BotDefaults{}, cause
				}
				if stage == "unavailable" {
					return botcore.BotDefaults{Reason: pointer("offline")}, nil
				}
				return botcore.BotDefaults{Configuration: &base}, nil
			}
			f.service.operations.workerDefaults = func(v model.BotDefaultsInput, o model.BotOverrides, w string) (model.BotConfiguration, error) {
				f.plan.call("baseline")
				if stage == "baseline" {
					return base, cause
				}
				return base, nil
			}
			f.service.models = modelRequestFunc(func(ctx context.Context, p model.Principal, w string, r ro.Request) (ro.Message, error) {
				f.plan.call("network")
				if stage == "network" {
					return ro.Message{}, cause
				}
				return nativeResponse(p, w, r), nil
			})
			f.service.operations.nativeSelection = func(b model.BotConfiguration, o model.BotOverrides, p model.BotNativePreference, c ro.ModelResult, selected *string) (model.BotConfiguration, error) {
				f.plan.call("selection")
				return base, cause
			}
			got, e := f.service.DefaultsFor(f.ctx, f.p, model.BotOverrides{})
			if stage == "unavailable" {
				same(t, e, nil)
				same(t, got.Reason, pointer("offline"))
				return
			}
			if stage == "credential missing" {
				requireFault(t, e, "unauthenticated")
				if !errors.Is(e, model.ErrNotFound) {
					t.Fatalf("lost missing credential cause: %v", e)
				}
			} else if !errors.Is(e, cause) {
				t.Fatalf("lost %s cause: %v", stage, e)
			}
			same(t, got, botcore.BotDefaults{})
		})
	}
}
