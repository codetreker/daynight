package assistanttask

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func itemInput() ItemInput {
	return ItemInput{Mutation: mutation(), Key: "build-1", Episode: 1, State: "open", Category: "failure", AppState: json.RawMessage(`{"operationId":"original-operation"}`)}
}

func TestItemWritesRetainApplicationStateAndUseItemVersion(t *testing.T) {
	for _, exists := range []bool{false, true} {
		t.Run(map[bool]string{false: "create", true: "update"}[exists], func(t *testing.T) {
			task := baseTask()
			d := baseDAO(t, task)
			input := itemInput()
			old := model.AssistantTaskItem{ID: entryID, OwnerUserID: ownerID, TaskID: taskID, Key: "build-1", Episode: 1, State: "open", Version: 3, FollowerBotID: ptr(targetID), AppState: json.RawMessage(`{"operationId":"original-operation"}`)}
			d.item = func(_ context.Context, owner, id, item string) (model.AssistantTaskItem, error) {
				if owner != ownerID || id != taskID || item != entryID {
					t.Fatal("wrong item scope")
				}
				if exists {
					return old, nil
				}
				return model.AssistantTaskItem{}, model.ErrNotFound
			}
			var written model.AssistantTaskItem
			if exists {
				input.ItemVersion, input.State = ptr(int64(3)), "closed"
				d.saveItem = func(_ context.Context, item model.AssistantTaskItem, version int64) (bool, error) {
					if version != 3 || item.Version != 4 {
						t.Fatal("missing item CAS")
					}
					written = item
					return true, nil
				}
			} else {
				d.insertItem = func(_ context.Context, item model.AssistantTaskItem) (bool, error) {
					if item.Version != 1 {
						t.Fatal("wrong initial item version")
					}
					written = item
					return true, nil
				}
			}
			expectTaskWrite(t, d, task, true)
			result, err := New().SaveItem(context.Background(), d, botActor(), input)
			if err != nil || result.ID != entryID || written.State != input.State || written.FollowerBotID == nil || *written.FollowerBotID != botID || string(written.AppState) != `{"operationId":"original-operation"}` {
				t.Fatalf("item: %#v %v", result, err)
			}
		})
	}
}

func TestItemRefusalsDoNotWrite(t *testing.T) {
	for _, name := range []string{"key", "episode", "state", "json", "paused", "user", "version", "immutable-key", "immutable-episode", "missing-update"} {
		t.Run(name, func(t *testing.T) {
			task, actor, input, code := baseTask(), botActor(), itemInput(), "invalid_input"
			switch name {
			case "key":
				input.Key = " key "
			case "episode":
				input.Episode = 0
			case "state":
				input.State = "done"
			case "json":
				input.AppState = json.RawMessage(`bad`)
			case "paused":
				task.State, code = "paused", "task_paused"
			case "user":
				actor, code = userActor(), "claim_lost"
			}
			d := baseDAO(t, task)
			if name == "version" || name == "immutable-key" || name == "immutable-episode" || name == "missing-update" {
				input.ItemVersion = ptr(int64(3))
				old := model.AssistantTaskItem{ID: entryID, Key: input.Key, Episode: input.Episode, Version: 3}
				if name == "version" {
					old.Version, code = 4, "version_conflict"
				}
				if name == "immutable-key" {
					old.Key = "other"
				}
				if name == "immutable-episode" {
					old.Episode = 2
				}
				d.item = func(context.Context, string, string, string) (model.AssistantTaskItem, error) {
					if name == "missing-update" {
						return model.AssistantTaskItem{}, model.ErrNotFound
					}
					return old, nil
				}
			}
			_, err := New().SaveItem(context.Background(), d, actor, input)
			if name == "missing-update" {
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatal(err)
				}
			} else {
				requireCode(t, err, code)
			}
		})
	}
}

func TestRecordUsesDAOAssignedPositionAndExplicitBotAuthor(t *testing.T) {
	task := baseTask()
	d := baseDAO(t, task)
	d.record = func(context.Context, string, string, string) (model.AssistantTaskRecord, error) {
		return model.AssistantTaskRecord{}, model.ErrNotFound
	}
	d.item = func(_ context.Context, owner, id, item string) (model.AssistantTaskItem, error) {
		if owner != ownerID || id != taskID || item != operationID {
			t.Fatal("wrong record item")
		}
		return model.AssistantTaskItem{ID: operationID}, nil
	}
	d.insertRecord = func(_ context.Context, record model.AssistantTaskRecord) (model.AssistantTaskRecord, error) {
		if record.ID != entryID || record.Author != "bot" || record.AuthorBotID == nil || *record.AuthorBotID != botID || record.Kind != "fact" || record.Text != "Observed response" || string(record.Refs) != `{"trace":"original"}` {
			t.Fatalf("wrong record: %#v", record)
		}
		record.CreatedAt = epoch.Add(time.Microsecond)
		return record, nil
	}
	expectTaskWrite(t, d, task, true)
	result, err := New().AddRecord(context.Background(), d, botActor(), RecordInput{Mutation: mutation(), ItemID: ptr(operationID), Kind: "fact", Text: "Observed response", Refs: json.RawMessage(`{ "trace": "original" }`)})
	if err != nil || result.CreatedAt != epoch.Add(time.Microsecond) {
		t.Fatalf("lost database record position: %#v %v", result, err)
	}
}

func TestOtherBotInterventionCannotWriteFactsOrUseForeignClaim(t *testing.T) {
	for _, kind := range []string{"action", "note", "fact", "foreign-claim"} {
		t.Run(kind, func(t *testing.T) {
			task, actor := baseTask(), botActor()
			actor.BotID = ptr(targetID)
			d := baseDAO(t, task)
			input := RecordInput{Mutation: Mutation{TaskID: taskID, ID: entryID}, Kind: kind, Text: "User requested intervention"}
			if kind == "foreign-claim" {
				input.Kind, input.ClaimGeneration, input.ClaimToken = "action", 2, token
			}
			if kind == "action" || kind == "note" {
				d.record = func(context.Context, string, string, string) (model.AssistantTaskRecord, error) {
					return model.AssistantTaskRecord{}, model.ErrNotFound
				}
				d.insertRecord = func(_ context.Context, record model.AssistantTaskRecord) (model.AssistantTaskRecord, error) {
					if record.AuthorBotID == nil || *record.AuthorBotID != targetID {
						t.Fatal("intervention impersonated holder")
					}
					return record, nil
				}
				expectSystemEffects(t, d, "", "intervention", botID)
				saved := expectTaskWrite(t, d, task, false)
				_, err := New().AddRecord(context.Background(), d, actor, input)
				if err != nil || !reflect.DeepEqual(saved.HolderBotID, task.HolderBotID) || saved.ClaimGeneration != 2 {
					t.Fatalf("intervention changed ownership: %#v %v", saved, err)
				}
				return
			}
			_, err := New().AddRecord(context.Background(), d, actor, input)
			code := "forbidden"
			if kind == "foreign-claim" {
				code = "claim_lost"
			}
			requireCode(t, err, code)
		})
	}
}

func TestRecordClockFailureRetainsCauseAndStopsTaskWrite(t *testing.T) {
	d := baseDAO(t, baseTask())
	d.record = func(context.Context, string, string, string) (model.AssistantTaskRecord, error) {
		return model.AssistantTaskRecord{}, model.ErrNotFound
	}
	d.insertRecord = func(context.Context, model.AssistantTaskRecord) (model.AssistantTaskRecord, error) {
		return model.AssistantTaskRecord{}, &store.ThreadClockError{Cause: sentinel}
	}
	_, err := New().AddRecord(context.Background(), d, botActor(), RecordInput{Mutation: mutation(), Kind: "unknown", Text: "Unknown original outcome"})
	requireCode(t, err, "clock_not_advanced")
	if !errors.Is(err, sentinel) {
		t.Fatalf("lost record-clock cause: %v", err)
	}
}

func TestProtectedWorkRechecksOriginalLeaseAfterRecordWrite(t *testing.T) {
	task := baseTask()
	d := baseDAO(t, task)
	d.record = func(context.Context, string, string, string) (model.AssistantTaskRecord, error) {
		return model.AssistantTaskRecord{}, model.ErrNotFound
	}
	d.insertRecord = func(_ context.Context, record model.AssistantTaskRecord) (model.AssistantTaskRecord, error) {
		return record, nil
	}
	expectTaskWrite(t, d, task, true)
	reads := 0
	d.now = func(context.Context) (time.Time, error) {
		reads++
		if reads > 1 {
			return *task.LeaseUntil, nil
		}
		return epoch, nil
	}
	_, err := New().AddRecord(context.Background(), d, botActor(), RecordInput{Mutation: mutation(), Kind: "fact", Text: "Late write"})
	requireCode(t, err, "claim_lost")
}
