package assistanttask

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestEventAttentionFollowsUserDecisionNeeds(t *testing.T) {
	for _, tc := range []struct {
		kind      string
		attention bool
	}{
		{"report", true}, {"escalation", true}, {"result_unknown", true}, {"proposal_pending", true}, {"inquiry_timed_out", true}, {"takeover", true}, {"claim_lost", true},
		{"update", false}, {"resolved", false}, {"direct_success", false}, {"proposal_decided", false}, {"appendix_added", false}, {"inquiry", false}, {"answer", false}, {"transfer", false}, {"intervention", false}, {"trigger", false},
	} {
		got, err := eventAttention(tc.kind)
		if err != nil || got != tc.attention {
			t.Errorf("%s: %v %v", tc.kind, got, err)
		}
	}
	_, err := eventAttention("invented")
	requireCode(t, err, "invalid_input")
}

func TestAddEventUsesResponsibleBotAndPreservesApplicationPayload(t *testing.T) {
	task := baseTask()
	d := baseDAO(t, task)
	d.event = func(context.Context, string, string, string) (model.AssistantTaskEvent, error) {
		return model.AssistantTaskEvent{}, model.ErrNotFound
	}
	var saved model.AssistantTaskEvent
	d.insertEvent = func(_ context.Context, event model.AssistantTaskEvent) (bool, error) { saved = event; return true, nil }
	expectTaskWrite(t, d, task, true)
	result, err := New().AddEvent(context.Background(), d, botActor(), EventInput{Mutation: mutation(), TargetBotID: botID, Type: "report", Payload: json.RawMessage(`{ "key": "build-1" }`)})
	if err != nil || saved.TargetBotID != botID || saved.State != "pending" || !saved.Attention || string(saved.Payload) != `{"key":"build-1"}` || result.ID != entryID {
		t.Fatalf("event: %#v %v", result, err)
	}
}

func TestAddEventRejectsSystemTypesAndForeignTargets(t *testing.T) {
	for _, kind := range []string{"claim_lost", "proposal_pending", "answer", "report"} {
		d := baseDAO(t, baseTask())
		_, err := New().AddEvent(context.Background(), d, botActor(), EventInput{Mutation: mutation(), TargetBotID: targetID, Type: kind})
		requireCode(t, err, "forbidden")
	}
}

func TestEventAcknowledgmentRecordsOutcomeWithoutClearingAttention(t *testing.T) {
	for _, state := range []string{"", "delivered", "expired"} {
		t.Run("state="+state, func(t *testing.T) {
			task := baseTask()
			d := baseDAO(t, task)
			original := model.AssistantTaskEvent{ID: entryID, OwnerUserID: ownerID, TaskID: taskID, TargetBotID: botID, State: "pending", Type: "proposal_pending", Attention: true, SeenAt: ptr(epoch.Add(-time.Minute))}
			d.event = func(context.Context, string, string, string) (model.AssistantTaskEvent, error) { return original, nil }
			var saved model.AssistantTaskEvent
			d.saveEvent = func(_ context.Context, event model.AssistantTaskEvent, previous string) (bool, error) {
				if previous != "pending" {
					t.Fatal("missing pending CAS")
				}
				saved = event
				return true, nil
			}
			expectTaskWrite(t, d, task, false)
			result, err := New().AckEvent(context.Background(), d, botActor(), AckEventInput{TaskID: taskID, ID: entryID, OperationID: operationID, State: state})
			want := state
			if want == "" {
				want = "delivered"
			}
			if err != nil || result.State != want || saved.AckOperationID == nil || *saved.AckOperationID != operationID || saved.AckFingerprint == nil || !saved.Attention || !reflect.DeepEqual(saved.SeenAt, original.SeenAt) {
				t.Fatalf("acknowledgment: %#v %v", result, err)
			}
			if want == "expired" && saved.DeliveredAt != nil || want == "delivered" && (saved.DeliveredAt == nil || *saved.DeliveredAt != epoch) {
				t.Fatalf("wrong delivery fact: %#v", saved)
			}
		})
	}
}

func TestEventAcknowledgmentReplayBindsOriginalOutcome(t *testing.T) {
	for _, state := range []string{"expired", "delivered"} {
		t.Run(state, func(t *testing.T) {
			d := baseDAO(t, baseTask())
			hash := savedFingerprint(t, []any{operationID, taskID, entryID, botID, "expired"})
			d.event = func(context.Context, string, string, string) (model.AssistantTaskEvent, error) {
				return model.AssistantTaskEvent{ID: entryID, TargetBotID: botID, State: "expired", AckOperationID: ptr(operationID), AckFingerprint: ptr(hash)}, nil
			}
			result, err := New().AckEvent(context.Background(), d, botActor(), AckEventInput{TaskID: taskID, ID: entryID, OperationID: operationID, State: state})
			if state == "delivered" {
				requireCode(t, err, "operation_conflict")
			} else if err != nil || result.State != "expired" || result.DeliveredAt != nil {
				t.Fatalf("expired replay: %#v %v", result, err)
			}
		})
	}
}

func TestEventAcknowledgmentRejectsWrongIdentityStateAndLostCAS(t *testing.T) {
	for _, name := range []string{"user", "target", "state", "already-expired", "other-operation", "cas", "save-error"} {
		t.Run(name, func(t *testing.T) {
			d, actor := baseDAO(t, baseTask()), botActor()
			event := model.AssistantTaskEvent{ID: entryID, TargetBotID: botID, State: "pending"}
			input := AckEventInput{TaskID: taskID, ID: entryID, OperationID: operationID}
			code := "forbidden"
			switch name {
			case "user":
				actor = userActor()
			case "target":
				event.TargetBotID = targetID
			case "state":
				input.State, code = "pending", "invalid_input"
			case "already-expired":
				event.State, code = "expired", "invalid_transition"
			case "other-operation":
				event.AckOperationID, code = ptr(targetID), "operation_conflict"
			case "cas", "save-error":
				code = "version_conflict"
				d.saveEvent = func(context.Context, model.AssistantTaskEvent, string) (bool, error) {
					if name == "save-error" {
						return false, sentinel
					}
					return false, nil
				}
			}
			d.event = func(context.Context, string, string, string) (model.AssistantTaskEvent, error) { return event, nil }
			_, err := New().AckEvent(context.Background(), d, actor, input)
			if name == "save-error" {
				if !errors.Is(err, sentinel) {
					t.Fatal(err)
				}
			} else {
				requireCode(t, err, code)
			}
		})
	}
}

func TestClearAttentionExcludesUndecidedProposalsAndRechecksTarget(t *testing.T) {
	d := baseDAO(t, baseTask())
	checks, writes := 0, 0
	d.bot = func(_ context.Context, id string) (model.Bot, error) {
		checks++
		if id != targetID {
			t.Fatal("wrong target")
		}
		return model.Bot{ID: id, OwnerUserID: ownerID}, nil
	}
	d.seen = func(_ context.Context, owner, target string, at time.Time, except []string) error {
		writes++
		if owner != ownerID || target != targetID || at != epoch || !reflect.DeepEqual(except, []string{"proposal_pending"}) {
			t.Fatal("wrong attention scope or excluded proposal type")
		}
		return nil
	}
	if err := New().ClearAttention(context.Background(), d, userActor(), targetID); err != nil {
		t.Fatal(err)
	}
	if checks != 2 || writes != 1 {
		t.Fatalf("missing final target admission: %d %d", checks, writes)
	}
	requireCode(t, New().ClearAttention(context.Background(), &daoStub{}, botActor(), targetID), "forbidden")
}
