package bot

import (
	"context"
	"errors"
	"strings"
	"testing"

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
			input := model.BotDefaultsInput{WorkerPreferences: map[string]model.BotWorkerPreference{worker: {Native: map[string]model.BotNativePreference{base.Provider: {}}}}}
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
				return botcore.BotDefaults{Configuration: &base, WorkerID: &worker, Workers: []botcore.BotWorkerDefaults{{WorkerID: worker, Configuration: &base}, {WorkerID: uuid.NewString()}}}, nil
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
			same(t, got.Configuration, &want)
			same(t, got.Workers[0].Configuration, got.Configuration)
			same(t, got.Workers[1].Configuration, (*model.BotConfiguration)(nil))
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
