package assistanttask

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func expectTaskWrite(t *testing.T, d *daoStub, task model.AssistantTask, live bool) *model.AssistantTask {
	t.Helper()
	var saved model.AssistantTask
	calls := 0
	d.saveTask = func(_ context.Context, value model.AssistantTask, condition store.AssistantTaskCondition) (bool, error) {
		calls++
		want := store.AssistantTaskCondition{Version: task.Version}
		if live {
			want = store.AssistantTaskCondition{Version: task.Version, CheckClaim: true, LiveClaim: true, Generation: task.ClaimGeneration, HolderBotID: task.HolderBotID, TokenHash: task.ClaimTokenHash}
		}
		if !reflect.DeepEqual(condition, want) || value.Version != task.Version+1 || value.ID != task.ID || value.OwnerUserID != ownerID {
			t.Fatalf("wrong task write: %#v %#v", value, condition)
		}
		saved = value
		return true, nil
	}
	t.Cleanup(func() {
		if calls != 1 {
			t.Errorf("want one task write, got %d", calls)
		}
	})
	return &saved
}

func createInput() CreateInput {
	return CreateInput{ID: taskID, Name: "Watch", Purpose: "Find failures", Scope: "Builds", Kind: "continuous", Takeover: "auto", Body: "# Instructions", Trigger: json.RawMessage(`{ "minutes": 2, "kind": "interval" }`)}
}

func TestCreateAppendsInitialManualAndUsesOwnerCreationBarrier(t *testing.T) {
	d := baseDAO(t, baseTask())
	locked, inserted := false, false
	d.lockCreation = func(_ context.Context, id string) error {
		if id != taskID {
			t.Fatal("wrong creation barrier")
		}
		locked = true
		return nil
	}
	d.task = func(_ context.Context, owner, id string, lock bool) (model.AssistantTask, error) {
		if !locked || owner != ownerID || id != taskID || !lock {
			t.Fatal("task read did not follow creation barrier")
		}
		return model.AssistantTask{}, model.ErrNotFound
	}
	d.insertTask = func(_ context.Context, task model.AssistantTask) (bool, error) {
		if task.ID != taskID || task.OwnerUserID != ownerID || task.Version != 1 || task.ManualVersion != 1 || task.State != "active" || task.ClaimGeneration != 0 || task.HolderBotID != nil || task.RequestFingerprint == "" || string(task.Trigger) != `{"kind":"interval","minutes":2}` {
			t.Fatalf("wrong initial task: %#v", task)
		}
		inserted = true
		return true, nil
	}
	d.insertManual = func(_ context.Context, manual model.AssistantTaskManual) error {
		if !inserted || manual.OwnerUserID != ownerID || manual.TaskID != taskID || manual.Version != 1 || manual.Source != "initial" || manual.Body != "# Instructions" || string(manual.Rules) != "null" || manual.CreatedAt != epoch {
			t.Fatalf("wrong initial manual: %#v", manual)
		}
		return nil
	}
	result, err := New().Create(context.Background(), d, userActor(), createInput())
	if err != nil || result.Claim.State != "unowned" || result.Task.Name != "Watch" || result.Claim.ObservedAt != epoch {
		t.Fatalf("create: %#v %v", result, err)
	}
}

func TestCreateReplayReturnsCurrentResourceWithoutRewriting(t *testing.T) {
	input := createInput()
	input.Trigger = json.RawMessage(`{"kind":"interval","minutes":2}`)
	input.Rules = json.RawMessage("null")
	task := baseTask()
	task.RequestFingerprint = savedFingerprint(t, input)
	task.Name = "Changed later"
	d := baseDAO(t, task)
	d.lockCreation = func(context.Context, string) error { return nil }
	d.now = func(context.Context) (time.Time, error) { return epoch.Add(time.Minute), nil }
	got, err := New().Create(context.Background(), d, userActor(), createInput())
	if err != nil || got.Task.Name != task.Name || got.Claim.ObservedAt != task.ObservedAt {
		t.Fatalf("replay must use current stored projection: %#v %v", got, err)
	}
}

func TestCreateRejectsInvalidInputBeforeStorage(t *testing.T) {
	for _, name := range []string{"bot", "id", "name", "body", "kind", "takeover", "rules", "trigger"} {
		t.Run(name, func(t *testing.T) {
			input, actor, code := createInput(), userActor(), "invalid_input"
			switch name {
			case "bot":
				actor, code = botActor(), "forbidden"
			case "id":
				input.ID = "bad"
			case "name":
				input.Name = "  "
			case "body":
				input.Body = ""
			case "kind":
				input.Kind = "repeating"
			case "takeover":
				input.Takeover = "other"
			case "rules":
				input.Rules = json.RawMessage(`{"mayDelete":true}`)
			case "trigger":
				input.Trigger = json.RawMessage(`{"kind":"interval","minutes":0}`)
			}
			_, err := New().Create(context.Background(), &daoStub{}, actor, input)
			requireCode(t, err, code)
		})
	}
}

func TestCreateStopsAtFailedStorageStep(t *testing.T) {
	for _, step := range []string{"barrier", "read", "clock", "insert", "insert-conflict", "manual", "final-auth"} {
		t.Run(step, func(t *testing.T) {
			d := baseDAO(t, baseTask())
			d.lockCreation = func(context.Context, string) error {
				if step == "barrier" {
					return sentinel
				}
				return nil
			}
			d.task = func(context.Context, string, string, bool) (model.AssistantTask, error) {
				if step == "read" {
					return model.AssistantTask{}, sentinel
				}
				return model.AssistantTask{}, model.ErrNotFound
			}
			d.now = func(context.Context) (time.Time, error) {
				if step == "clock" {
					return time.Time{}, sentinel
				}
				return epoch, nil
			}
			d.insertTask = func(context.Context, model.AssistantTask) (bool, error) {
				if step == "insert" {
					return false, sentinel
				}
				return step != "insert-conflict", nil
			}
			d.insertManual = func(context.Context, model.AssistantTaskManual) error {
				if step == "manual" {
					return sentinel
				}
				if step != "final-auth" {
					t.Fatal("continued after failure")
				}
				return nil
			}
			authCalls := 0
			d.credential = func(context.Context, model.Principal) error {
				authCalls++
				if step == "final-auth" && authCalls == 2 {
					return sentinel
				}
				return nil
			}
			_, err := New().Create(context.Background(), d, userActor(), createInput())
			if step == "insert-conflict" {
				requireCode(t, err, "operation_conflict")
			} else if !errors.Is(err, sentinel) {
				t.Fatalf("lost %s error: %v", step, err)
			}
		})
	}
}

func TestTaskUpdatePreservesClaimUntilDeletion(t *testing.T) {
	for _, state := range []string{"paused", "deleted"} {
		t.Run(state, func(t *testing.T) {
			task := baseTask()
			d := baseDAO(t, task)
			reads := 0
			d.task = func(context.Context, string, string, bool) (model.AssistantTask, error) {
				reads++
				if reads == 1 {
					return task, nil
				}
				if state == "deleted" {
					return model.AssistantTask{ID: taskID, OwnerUserID: ownerID, State: "deleted", Version: 8, ClaimGeneration: 3, ObservedAt: epoch}, nil
				}
				fresh := task
				fresh.Version, fresh.State = 8, state
				return fresh, nil
			}
			removed := false
			if state == "deleted" {
				d.deleteTaskContent = func(_ context.Context, owner, id string) error {
					if owner != ownerID || id != taskID {
						t.Fatal("wrong delete scope")
					}
					removed = true
					return nil
				}
			}
			saved := expectTaskWrite(t, d, task, false)
			result, err := New().Update(context.Background(), d, userActor(), UpdateInput{TaskID: taskID, IfVersion: 7, State: &state})
			if err != nil || saved.State != state || result.Task.Version != 8 {
				t.Fatalf("update: %#v %v", result, err)
			}
			if state == "deleted" {
				if !removed || saved.ManualVersion != 0 || saved.ClaimGeneration != 3 || saved.HolderBotID != nil || saved.LeaseUntil != nil || saved.CredentialOperationID != nil || saved.ClaimTokenHash != nil || saved.Name != "" || saved.Purpose != "" || saved.Scope != "" || saved.Trigger != nil {
					t.Fatal("deleted task retained material or credential")
				}
			} else if result.Claim.State != "active" || !reflect.DeepEqual(saved.LeaseUntil, task.LeaseUntil) || saved.ClaimGeneration != task.ClaimGeneration {
				t.Fatal("pause changed claim")
			}
		})
	}
}

func TestTaskUpdateNoopAndTriggerClear(t *testing.T) {
	task := baseTask()
	d := baseDAO(t, task)
	result, err := New().Update(context.Background(), d, userActor(), UpdateInput{TaskID: taskID, IfVersion: 7, Name: &task.Name})
	if err != nil || result.Task.Version != 7 {
		t.Fatalf("no-op wrote version: %#v %v", result, err)
	}
	task.Trigger = json.RawMessage(`{"kind":"interval","minutes":5}`)
	d = baseDAO(t, task)
	saved := expectTaskWrite(t, d, task, false)
	_, err = New().Update(context.Background(), d, userActor(), UpdateInput{TaskID: taskID, IfVersion: 7, Trigger: ptr(json.RawMessage("null"))})
	if err != nil || string(saved.Trigger) != "null" {
		t.Fatalf("clear trigger: %#v %v", saved, err)
	}
}

func TestTaskUpdateReturnsFreshHolderDeletionProjection(t *testing.T) {
	task := baseTask()
	d := baseDAO(t, task)
	reads := 0
	d.task = func(_ context.Context, owner, id string, lock bool) (model.AssistantTask, error) {
		reads++
		if owner != ownerID || id != taskID {
			t.Fatal("wrong task scope")
		}
		if reads == 1 {
			if !lock {
				t.Fatal("update must acquire task barrier")
			}
			return task, nil
		}
		fresh := task
		fresh.Version, fresh.State, fresh.HolderDeleted, fresh.ObservedAt = 8, "paused", true, epoch.Add(time.Minute)
		return fresh, nil
	}
	d.now = func(context.Context) (time.Time, error) { return epoch.Add(time.Minute), nil }
	expectTaskWrite(t, d, task, false)
	result, err := New().Update(context.Background(), d, userActor(), UpdateInput{TaskID: taskID, IfVersion: 7, State: ptr("paused")})
	if err != nil || reads != 2 || result.Claim.State != "expired" || result.Claim.ObservedAt != epoch.Add(time.Minute) {
		t.Fatalf("stale holder projection paired with new time: %#v reads=%d err=%v", result, reads, err)
	}
}

func TestTaskUpdateRejectsInvalidChangesAndStaleVersion(t *testing.T) {
	for _, name := range []string{"bot", "empty", "stale", "zero", "name", "purpose", "takeover", "state", "trigger", "overflow"} {
		t.Run(name, func(t *testing.T) {
			task, actor, code := baseTask(), userActor(), "invalid_input"
			input := UpdateInput{TaskID: taskID, IfVersion: 7, Name: ptr("New")}
			switch name {
			case "bot":
				actor, code = botActor(), "forbidden"
			case "empty":
				input.Name = nil
			case "stale":
				input.IfVersion, code = 6, "version_conflict"
			case "zero":
				input.IfVersion = 0
			case "name":
				input.Name = ptr(" ")
			case "purpose":
				input.Purpose = ptr("\x00")
			case "takeover":
				input.Takeover = ptr("bad")
			case "state":
				input.State = ptr("done")
			case "trigger":
				input.Trigger = ptr(json.RawMessage(`false`))
			case "overflow":
				task.Version, input.IfVersion = math.MaxInt64, math.MaxInt64
			}
			_, err := New().Update(context.Background(), baseDAO(t, task), actor, input)
			requireCode(t, err, code)
		})
	}
}

func TestReadResourcesUsesTaskOwnershipAndSnapshotTime(t *testing.T) {
	task := baseTask()
	d := baseDAO(t, task)
	d.task = func(_ context.Context, owner, id string, lock bool) (model.AssistantTask, error) {
		if owner != ownerID || id != taskID || lock {
			t.Fatal("wrong read scope or exclusive read lock")
		}
		return task, nil
	}
	d.now = func(context.Context) (time.Time, error) { return epoch.Add(time.Hour), nil }
	got, err := New().Get(context.Background(), d, botActor(), taskID)
	if err != nil || got.Claim.State != "active" || got.Claim.ObservedAt != epoch {
		t.Fatalf("read mixed projection time: %#v %v", got, err)
	}
	d.manual = func(_ context.Context, owner, id string, version int64) (model.AssistantTaskManual, error) {
		if owner != ownerID || id != taskID || version != 1 {
			t.Fatal("wrong current manual")
		}
		return model.AssistantTaskManual{Version: version, Body: "Current"}, nil
	}
	manual, err := New().GetManual(context.Background(), d, userActor(), taskID, 0)
	if err != nil || manual.Body != "Current" {
		t.Fatal(manual, err)
	}
	d.item = func(_ context.Context, owner, id, entry string) (model.AssistantTaskItem, error) {
		if owner != ownerID || id != taskID || entry != entryID {
			t.Fatal("wrong item scope")
		}
		return model.AssistantTaskItem{ID: entryID, Key: "build"}, nil
	}
	item, err := New().GetItem(context.Background(), d, userActor(), taskID, entryID)
	if err != nil || item.Key != "build" {
		t.Fatal(item, err)
	}
}

func TestRulesRegistryPreservesBoundaryDecisionAndError(t *testing.T) {
	m := New()
	if err := m.RegisterRules("builds", func(old, next json.RawMessage) (bool, error) {
		if string(old) != `{"level":1}` || string(next) != `{"level":2}` {
			t.Fatalf("wrong rule inputs: %s %s", old, next)
		}
		return true, sentinel
	}); err != nil {
		t.Fatal(err)
	}
	_, wider, err := m.rules("builds", json.RawMessage(`{"level":1}`), json.RawMessage(`{ "level": 2 }`))
	if !wider || !errors.Is(err, sentinel) {
		t.Fatalf("lost validator decision: %v %v", wider, err)
	}
	requireCode(t, m.RegisterRules("builds", func(json.RawMessage, json.RawMessage) (bool, error) { return false, nil }), "invalid_input")
	requireCode(t, m.RegisterRules("empty", nil), "invalid_input")
	for _, raw := range []string{"null", "[]", "{}"} {
		if _, wider, err := m.rules("unregistered", nil, json.RawMessage(raw)); err != nil || wider {
			t.Fatal(raw, wider, err)
		}
	}
	_, _, err = m.rules("unregistered", nil, json.RawMessage(`{"level":2}`))
	requireCode(t, err, "invalid_input")
}
