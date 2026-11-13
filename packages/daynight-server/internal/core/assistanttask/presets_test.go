package assistanttask

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"math"
	"testing"
	"time"
)

type presetDAO struct {
	*daoStub
	application func(context.Context, string, string) (model.AssistantTask, error)
}

func (d *presetDAO) ApplicationTask(ctx context.Context, owner, application string) (model.AssistantTask, error) {
	return d.application(ctx, owner, application)
}
func presetFixture(t *testing.T, task model.AssistantTask) *presetDAO {
	return &presetDAO{daoStub: baseDAO(t, task), application: func(_ context.Context, owner, application string) (model.AssistantTask, error) {
		if owner != ownerID || application != "example" {
			t.Fatal("wrong singleton scope")
		}
		return task, nil
	}}
}
func presetInput() CreateInput { v := createInput(); v.Application = "example"; return v }

func TestPresetExistingHolderPreservesManualAndClaim(t *testing.T) {
	task := baseTask()
	d := presetFixture(t, task)
	input := presetInput()
	input.ID = entryID
	got, err := New().EnablePreset(t.Context(), d, userActor(), input, botID)
	if err != nil || got.Task.ID != taskID || got.Task.Version != task.Version || got.Task.ClaimTokenHash == nil || *got.Task.ClaimTokenHash != tokenHash {
		t.Fatalf("existing result %#v %v", got, err)
	}
}
func TestPresetResumesAndTransfersAtomically(t *testing.T) {
	for _, name := range []string{"paused", "different holder", "expired", "unowned"} {
		t.Run(name, func(t *testing.T) {
			task := baseTask()
			target := botID
			switch name {
			case "paused":
				task.State = "paused"
			case "different holder":
				target = targetID
			case "expired":
				task.LeaseUntil = ptr(epoch)
			case "unowned":
				task.HolderBotID = nil
			}
			d := presetFixture(t, task)
			saved := expectTaskWrite(t, d.daoStub, task, false)
			transferred := 0
			events := []string{}
			d.transferOpenItems = func(_ context.Context, owner, id string, bot *string) error {
				if owner != ownerID || id != taskID || *bot != target {
					t.Fatal("wrong item transfer")
				}
				transferred++
				return nil
			}
			d.insertEvent = func(_ context.Context, e model.AssistantTaskEvent) (bool, error) {
				events = append(events, e.Type)
				return true, nil
			}
			got, err := New().EnablePreset(t.Context(), d, userActor(), presetInput(), target)
			if err != nil || got.Task.State != "active" || *got.Task.HolderBotID != target {
				t.Fatalf("result %#v %v", got, err)
			}
			if name == "paused" {
				if transferred != 0 || len(events) != 0 || saved.ClaimGeneration != task.ClaimGeneration {
					t.Fatal("resume changed ownership")
				}
			} else {
				if transferred != 1 || saved.ClaimGeneration != task.ClaimGeneration+1 || got.Claim.State != "pending" || saved.ClaimTokenHash != nil || saved.CredentialOperationID != nil || !saved.LeaseUntil.Equal(epoch.Add(LeaseDuration)) {
					t.Fatalf("assignment %#v", saved)
				}
				if len(events) == 0 || events[0] != "transfer" {
					t.Fatal(events)
				}
				if name == "different holder" && (len(events) != 2 || events[1] != "claim_lost") {
					t.Fatal(events)
				}
			}
		})
	}
}
func TestPresetCreatesManualAndRecoversConcurrentSingleton(t *testing.T) {
	for _, race := range []bool{false, true} {
		t.Run(map[bool]string{false: "create", true: "concurrent winner"}[race], func(t *testing.T) {
			task := baseTask()
			d := presetFixture(t, task)
			reads := 0
			inserted := false
			manuals := 0
			d.application = func(context.Context, string, string) (model.AssistantTask, error) {
				reads++
				if race && reads > 1 {
					return task, nil
				}
				return model.AssistantTask{}, model.ErrNotFound
			}
			d.lockCreation = func(context.Context, string) error { return nil }
			d.task = func(_ context.Context, owner, id string, lock bool) (model.AssistantTask, error) {
				if !lock {
					t.Fatal("missing task lock")
				}
				if !inserted {
					return model.AssistantTask{}, model.ErrNotFound
				}
				return task, nil
			}
			d.insertTask = func(_ context.Context, v model.AssistantTask) (bool, error) { inserted = true; return !race, nil }
			d.insertManual = func(_ context.Context, v model.AssistantTaskManual) error {
				manuals++
				if v.Body != presetInput().Body {
					t.Fatal("manual changed")
				}
				return nil
			}
			got, err := New().EnablePreset(t.Context(), d, userActor(), presetInput(), botID)
			if err != nil || got.Task.ID != taskID || !inserted {
				t.Fatalf("result %#v %v", got, err)
			}
			if race && manuals != 0 || !race && manuals != 1 {
				t.Fatal("wrong manual writes", manuals)
			}
		})
	}
}
func TestPresetFailurePaths(t *testing.T) {
	for _, step := range []string{"bot actor", "invalid id", "auth", "target", "application", "create", "missing winner", "locked read", "clock", "generation", "save", "items", "event", "lost event", "final auth"} {
		t.Run(step, func(t *testing.T) {
			task := baseTask()
			task.State = "paused"
			d := presetFixture(t, task)
			a := userActor()
			input := presetInput()
			target := targetID
			d.saveTask = func(context.Context, model.AssistantTask, store.AssistantTaskCondition) (bool, error) {
				return true, nil
			}
			d.transferOpenItems = func(context.Context, string, string, *string) error { return nil }
			d.insertEvent = func(context.Context, model.AssistantTaskEvent) (bool, error) { return true, nil }
			switch step {
			case "bot actor":
				a = botActor()
			case "invalid id":
				input.ID = "bad"
			case "auth":
				d.credential = func(context.Context, model.Principal) error { return sentinel }
			case "target":
				d.bot = func(context.Context, string) (model.Bot, error) { return model.Bot{}, sentinel }
			case "application":
				d.application = func(context.Context, string, string) (model.AssistantTask, error) {
					return model.AssistantTask{}, sentinel
				}
			case "create", "missing winner":
				d.application = func(context.Context, string, string) (model.AssistantTask, error) {
					return model.AssistantTask{}, model.ErrNotFound
				}
				d.lockCreation = func(context.Context, string) error {
					if step == "create" {
						return sentinel
					}
					return fault("operation_conflict", "collision")
				}
			case "locked read":
				d.task = func(context.Context, string, string, bool) (model.AssistantTask, error) {
					return model.AssistantTask{}, sentinel
				}
			case "clock":
				d.now = func(context.Context) (time.Time, error) { return time.Time{}, sentinel }
			case "generation":
				task.ClaimGeneration = math.MaxInt64
				d = presetFixture(t, task)
			case "save":
				d.saveTask = func(context.Context, model.AssistantTask, store.AssistantTaskCondition) (bool, error) {
					return false, sentinel
				}
			case "items":
				d.transferOpenItems = func(context.Context, string, string, *string) error { return sentinel }
			case "event", "lost event":
				d.insertEvent = func(_ context.Context, e model.AssistantTaskEvent) (bool, error) {
					if step == "event" || e.Type == "claim_lost" {
						return false, sentinel
					}
					return true, nil
				}
			case "final auth":
				calls := 0
				d.credential = func(context.Context, model.Principal) error {
					calls++
					if calls == 3 {
						return sentinel
					}
					return nil
				}
			}
			_, err := New().EnablePreset(t.Context(), d, a, input, target)
			if err == nil {
				t.Fatal("failure accepted")
			}
			if step != "bot actor" && step != "invalid id" && step != "generation" && step != "missing winner" && !errors.Is(err, sentinel) {
				t.Fatalf("lost error %v", err)
			}
		})
	}
}
