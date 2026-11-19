package assistanttask_test

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestOutcomeRecordRoundTripsBesideLegacyRows(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	bot := uuid.NewString()
	action := model.AssistantTaskRecord{ID: uuid.NewString(), OwnerUserID: f.owner, TaskID: f.task.ID, Author: "bot", AuthorBotID: &bot, Kind: "action", Text: "Restarted", RequestFingerprint: "action", Refs: json.RawMessage(`null`)}
	value := "ineffective"
	outcome := model.AssistantTaskRecord{ID: uuid.NewString(), OwnerUserID: f.owner, TaskID: f.task.ID, Author: "bot", AuthorBotID: &bot, Kind: "outcome", Text: "Failure returned", RequestFingerprint: "outcome", Outcome: &value, ActionRecordID: &action.ID, Refs: json.RawMessage(`{"eventIds": ["evt-1"]}`)}
	// Rows written before the outcome columns existed omit them entirely.
	legacy := uuid.NewString()
	if _, err := f.db.Pool.Exec(ctx, `INSERT INTO assistant_task_records(id,owner_user_id,task_id,request_fingerprint,author,kind,text,refs,created_at) VALUES($1,$2,$3,'legacy','system','note','Legacy','[]',clock_timestamp()-interval '1 hour')`, legacy, f.owner, f.task.ID); err != nil {
		t.Fatal(err)
	}
	f.write(t, func(d store.AssistantTaskDAO) error {
		var err error
		if action, err = d.InsertRecord(ctx, action); err != nil {
			return err
		}
		outcome, err = d.InsertRecord(ctx, outcome)
		return err
	})
	if outcome.Outcome == nil || *outcome.Outcome != value || outcome.ActionRecordID == nil || *outcome.ActionRecordID != action.ID || action.Outcome != nil || action.ActionRecordID != nil {
		t.Fatalf("insert did not return outcome columns: %#v %#v", action, outcome)
	}
	f.write(t, func(d store.AssistantTaskDAO) error {
		got, err := d.Record(ctx, f.owner, f.task.ID, outcome.ID)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(got, outcome) {
			t.Fatalf("outcome roundtrip: %#v != %#v", got, outcome)
		}
		page, err := d.Records(ctx, store.AssistantTaskQuery{OwnerUserID: f.owner, TaskID: f.task.ID, Limit: 10})
		if err != nil {
			return err
		}
		if len(page) != 3 || page[0].ID != legacy || page[0].Outcome != nil || page[0].ActionRecordID != nil || !reflect.DeepEqual(page[1], action) || !reflect.DeepEqual(page[2], outcome) {
			t.Fatalf("record page lost outcome columns: %#v", page)
		}
		return nil
	})
}
