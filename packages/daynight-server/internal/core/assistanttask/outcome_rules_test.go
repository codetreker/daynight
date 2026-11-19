package assistanttask

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

const actionID = "77777777-7777-4777-8777-777777777777"

func outcomeInput() RecordInput {
	return RecordInput{Mutation: mutation(), Kind: "outcome", Text: "Restart cleared the failure", Outcome: ptr("effective"), ActionRecordID: ptr(actionID), Refs: json.RawMessage(`{"eventIds":["evt-1"]}`)}
}

// outcomeDAO serves the referenced record from the task-scoped record lookup;
// any other ID is absent, as for a record of another task.
func outcomeDAO(t *testing.T, referenced *model.AssistantTaskRecord) *daoStub {
	t.Helper()
	d := baseDAO(t, baseTask())
	d.record = func(_ context.Context, owner, task, id string) (model.AssistantTaskRecord, error) {
		if owner != ownerID || task != taskID {
			t.Fatalf("record lookup left task scope: %s %s", owner, task)
		}
		if referenced != nil && id == referenced.ID {
			return *referenced, nil
		}
		return model.AssistantTaskRecord{}, model.ErrNotFound
	}
	return d
}

func TestOutcomeRecordStoresEvaluatedActionOfSameTask(t *testing.T) {
	for _, value := range []string{"effective", "ineffective", "inconclusive"} {
		t.Run(value, func(t *testing.T) {
			d := outcomeDAO(t, &model.AssistantTaskRecord{ID: actionID, TaskID: taskID, Kind: "action"})
			input := outcomeInput()
			input.Outcome = ptr(value)
			want := savedFingerprint(t, []any{entryID, taskID, ptr(botID), (*string)(nil), "outcome", input.Text, json.RawMessage(`{"eventIds":["evt-1"]}`), value, actionID})
			d.insertRecord = func(_ context.Context, record model.AssistantTaskRecord) (model.AssistantTaskRecord, error) {
				if record.Kind != "outcome" || record.Outcome == nil || *record.Outcome != value || record.ActionRecordID == nil || *record.ActionRecordID != actionID || string(record.Refs) != `{"eventIds":["evt-1"]}` || record.RequestFingerprint != want {
					t.Fatalf("wrong outcome record: %#v", record)
				}
				return record, nil
			}
			expectTaskWrite(t, d, baseTask(), true)
			result, err := New().AddRecord(context.Background(), d, botActor(), input)
			if err != nil || result.Outcome == nil || *result.Outcome != value {
				t.Fatalf("outcome not returned: %#v %v", result, err)
			}
		})
	}
}

func TestOutcomeRecordRefusalsDoNotWrite(t *testing.T) {
	for _, name := range []string{"missing-outcome", "unknown-outcome", "missing-action", "noncanonical-action", "referenced-note", "referenced-outcome", "other-task", "fact-with-outcome", "action-with-reference", "intervention"} {
		t.Run(name, func(t *testing.T) {
			input, actor, code := outcomeInput(), botActor(), "invalid_input"
			referenced := &model.AssistantTaskRecord{ID: actionID, TaskID: taskID, Kind: "action"}
			switch name {
			case "missing-outcome":
				input.Outcome = nil
			case "unknown-outcome":
				input.Outcome = ptr("resolved")
			case "missing-action":
				input.ActionRecordID = nil
			case "noncanonical-action":
				input.ActionRecordID = ptr("77777777-7777-4777-8777-77777777777A")
			case "referenced-note":
				referenced.Kind = "note"
			case "referenced-outcome":
				referenced.Kind = "outcome"
			case "other-task":
				referenced = nil
			case "fact-with-outcome":
				input.Kind, input.ActionRecordID = "fact", nil
			case "action-with-reference":
				input.Kind, input.Outcome = "action", nil
			case "intervention":
				actor.BotID, input.ClaimGeneration, input.ClaimToken, code = ptr(targetID), 0, "", "forbidden"
			}
			d := outcomeDAO(t, referenced)
			_, err := New().AddRecord(context.Background(), d, actor, input)
			requireCode(t, err, code)
		})
	}
}

func TestOutcomeReferenceReadFailureIsNotReportedAsInvalid(t *testing.T) {
	d := baseDAO(t, baseTask())
	d.record = func(context.Context, string, string, string) (model.AssistantTaskRecord, error) {
		return model.AssistantTaskRecord{}, sentinel
	}
	if _, err := New().AddRecord(context.Background(), d, botActor(), outcomeInput()); !errors.Is(err, sentinel) {
		t.Fatalf("lost reference read failure: %v", err)
	}
}

func TestOutcomeReplayMatchesOnlyTheSameEvaluation(t *testing.T) {
	saved := savedFingerprint(t, []any{entryID, taskID, ptr(botID), (*string)(nil), "outcome", "Restart cleared the failure", json.RawMessage(`{"eventIds":["evt-1"]}`), "effective", actionID})
	otherAction := "88888888-8888-4888-8888-888888888888"
	for _, name := range []string{"same", "different-value", "different-action"} {
		t.Run(name, func(t *testing.T) {
			d := baseDAO(t, baseTask())
			d.record = func(_ context.Context, _, _, id string) (model.AssistantTaskRecord, error) {
				switch id {
				case actionID, otherAction:
					return model.AssistantTaskRecord{ID: id, Kind: "action"}, nil
				case entryID:
					return model.AssistantTaskRecord{ID: entryID, Kind: "outcome", Outcome: ptr("effective"), ActionRecordID: ptr(actionID), CreatedAt: epoch.Add(-time.Minute), RequestFingerprint: saved}, nil
				}
				return model.AssistantTaskRecord{}, model.ErrNotFound
			}
			input := outcomeInput()
			switch name {
			case "different-value":
				input.Outcome = ptr("ineffective")
			case "different-action":
				input.ActionRecordID = ptr(otherAction)
			}
			result, err := New().AddRecord(context.Background(), d, botActor(), input)
			if name != "same" {
				requireCode(t, err, "operation_conflict")
				return
			}
			if err != nil || result.CreatedAt != epoch.Add(-time.Minute) || *result.Outcome != "effective" {
				t.Fatalf("replay changed outcome record: %#v %v", result, err)
			}
		})
	}
}
