package assistanttask_test

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
)

type fixture struct {
	db    *postgres.Store
	owner string
	task  model.AssistantTask
}

func setup(t *testing.T) fixture {
	t.Helper()
	db, err := postgres.Open(t.Context(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		for cause := err; cause != nil; cause = errors.Unwrap(cause) {
			t.Logf("%T: %v", cause, cause)
		}
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	now := time.Now().UTC().Truncate(time.Microsecond)
	owner := uuid.NewString()
	return fixture{db: db, owner: owner, task: model.AssistantTask{ID: uuid.NewString(), OwnerUserID: owner, Name: "Review", Purpose: "Collect facts", Scope: "Account", Kind: "continuous", State: "active", Takeover: "manual", RequestFingerprint: strings.Repeat("a", 64), Version: 1, ManualVersion: 1, CreatedAt: now, UpdatedAt: now}}
}

func (f fixture) write(t *testing.T, fn func(store.AssistantTaskDAO) error) {
	t.Helper()
	completion, err := f.db.WriteAssistantTask(t.Context(), func(s store.AssistantTaskScope) error { return fn(s.AssistantTaskDAO()) })
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("write %s: %v", completion.Outcome, err)
	}
}

func (f fixture) create(t *testing.T) {
	t.Helper()
	f.write(t, func(d store.AssistantTaskDAO) error {
		ok, err := d.InsertTask(t.Context(), f.task)
		if !ok && err == nil {
			t.Fatal("task insert skipped")
		}
		return err
	})
}

func TestTaskIdentityCASAndOwnerScope(t *testing.T) {
	f := setup(t)
	f.create(t)
	f.write(t, func(d store.AssistantTaskDAO) error {
		got, err := d.Task(t.Context(), f.owner, f.task.ID, true)
		if err != nil {
			return err
		}
		if got.ObservedAt.IsZero() {
			t.Fatal("database observation time is missing")
		}
		got.ObservedAt = time.Time{}
		if !reflect.DeepEqual(got, f.task) {
			t.Fatalf("task roundtrip: %#v", got)
		}
		candidate := f.task
		candidate.Name = "conflicting"
		ok, err := d.InsertTask(t.Context(), candidate)
		if err != nil {
			return err
		}
		if ok {
			t.Fatal("duplicate ID inserted")
		}
		candidate.Version = 2
		ok, err = d.SaveTask(t.Context(), candidate, store.AssistantTaskCondition{Version: 2})
		if err != nil {
			return err
		}
		if ok {
			t.Fatal("stale version saved")
		}
		ok, err = d.SaveTask(t.Context(), candidate, store.AssistantTaskCondition{Version: 1})
		if err != nil {
			return err
		}
		if !ok {
			t.Fatal("matching version refused")
		}
		foreign, err := d.Task(t.Context(), uuid.NewString(), f.task.ID, false)
		if err != nil || !reflect.DeepEqual(foreign, model.AssistantTask{ID: f.task.ID, OwnerUserID: f.owner}) {
			t.Fatalf("cross owner task disclosed material or lost ownership: %#v %v", foreign, err)
		}
		return nil
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		got, err := d.Task(t.Context(), f.owner, f.task.ID, false)
		if err != nil {
			return err
		}
		if got.Version != 2 || got.Name != "conflicting" {
			t.Fatalf("CAS was not persisted: %#v", got)
		}
		list, err := d.Tasks(t.Context(), store.AssistantTaskQuery{OwnerUserID: uuid.NewString(), Limit: 200})
		if err != nil {
			return err
		}
		if len(list) != 0 {
			t.Fatal("foreign task in list")
		}
		return nil
	})
}

func TestMaterialRoundTripsAndDeleteIsolation(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	stamp := f.task.CreatedAt
	manual := model.AssistantTaskManual{OwnerUserID: f.owner, TaskID: f.task.ID, Body: "Manual", Rules: json.RawMessage(`[]`), Source: "initial", Version: 1, CreatedAt: stamp}
	appendix := model.AssistantTaskAppendix{ID: uuid.NewString(), OwnerUserID: f.owner, TaskID: f.task.ID, Text: "Lesson", State: "active", RequestFingerprint: "appendix", SourceRecords: []string{}, Version: 1, CreatedAt: stamp, UpdatedAt: stamp}
	proposal := model.AssistantTaskProposal{ID: uuid.NewString(), OwnerUserID: f.owner, TaskID: f.task.ID, Body: "Revision", Reason: "Evidence", Status: "pending", RequestFingerprint: "proposal", BaseVersion: 1, Rules: json.RawMessage(`[]`), EvidenceRecords: []string{}, CreatedAt: stamp}
	item := model.AssistantTaskItem{ID: uuid.NewString(), OwnerUserID: f.owner, TaskID: f.task.ID, Key: "work", State: "open", Category: "fact", RequestFingerprint: "item", Episode: 1, Version: 1, AppState: json.RawMessage(`{}`), CreatedAt: stamp, UpdatedAt: stamp}
	record := model.AssistantTaskRecord{ID: uuid.NewString(), OwnerUserID: f.owner, TaskID: f.task.ID, Author: "user", Kind: "note", Text: "Evidence", RequestFingerprint: "record", Refs: json.RawMessage(`[]`)}
	event := model.AssistantTaskEvent{ID: uuid.NewString(), OwnerUserID: f.owner, TaskID: f.task.ID, TargetBotID: uuid.NewString(), Type: "proposal", State: "pending", RequestFingerprint: "event", Payload: json.RawMessage(`{}`), Attention: true, CreatedAt: stamp}
	inquiry := model.AssistantTaskInquiry{ID: uuid.NewString(), OwnerUserID: f.owner, TaskID: f.task.ID, FromBotID: event.TargetBotID, ToBotID: uuid.NewString(), Question: "Status?", State: "open", RequestFingerprint: "inquiry", CreatedAt: stamp, Deadline: stamp.Add(5 * time.Minute)}
	f.write(t, func(d store.AssistantTaskDAO) error {
		if err := d.InsertManual(ctx, manual); err != nil {
			return err
		}
		for _, insert := range []func() (bool, error){func() (bool, error) { return d.InsertAppendix(ctx, appendix) }, func() (bool, error) { return d.InsertProposal(ctx, proposal) }, func() (bool, error) { return d.InsertItem(ctx, item) }, func() (bool, error) { return d.InsertEvent(ctx, event) }, func() (bool, error) { return d.InsertInquiry(ctx, inquiry) }} {
			ok, err := insert()
			if err != nil {
				return err
			}
			if !ok {
				t.Fatal("material insertion skipped")
			}
		}
		var err error
		record, err = d.InsertRecord(ctx, record)
		return err
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		checks := []func() (any, error){func() (any, error) { return d.Manual(ctx, f.owner, f.task.ID, 1) }, func() (any, error) { return d.Appendix(ctx, f.owner, f.task.ID, appendix.ID) }, func() (any, error) { return d.Proposal(ctx, f.owner, f.task.ID, proposal.ID) }, func() (any, error) { return d.Item(ctx, f.owner, f.task.ID, item.ID) }, func() (any, error) { return d.Record(ctx, f.owner, f.task.ID, record.ID) }, func() (any, error) { return d.Event(ctx, f.owner, f.task.ID, event.ID) }, func() (any, error) { return d.Inquiry(ctx, f.owner, f.task.ID, inquiry.ID) }}
		for i, want := range []any{manual, appendix, proposal, item, record, event, inquiry} {
			got, err := checks[i]()
			if err != nil {
				return err
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("material %d roundtrip: %#v != %#v", i, got, want)
			}
		}
		foreign := uuid.NewString()
		for i, read := range []func() (any, error){func() (any, error) { return d.Manual(ctx, foreign, f.task.ID, 1) }, func() (any, error) { return d.Appendix(ctx, foreign, f.task.ID, appendix.ID) }, func() (any, error) { return d.Proposal(ctx, foreign, f.task.ID, proposal.ID) }, func() (any, error) { return d.Item(ctx, foreign, f.task.ID, item.ID) }, func() (any, error) { return d.Record(ctx, foreign, f.task.ID, record.ID) }, func() (any, error) { return d.Event(ctx, foreign, f.task.ID, event.ID) }, func() (any, error) { return d.Inquiry(ctx, foreign, f.task.ID, inquiry.ID) }} {
			if _, err := read(); !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("material %d disclosed to foreign owner: %v", i, err)
			}
		}
		return nil
	})
	// A foreign owner cannot purge another user's rows even with known IDs.
	f.write(t, func(d store.AssistantTaskDAO) error { return d.DeleteTaskContent(ctx, uuid.NewString(), f.task.ID) })
	f.write(t, func(d store.AssistantTaskDAO) error { _, err := d.Manual(ctx, f.owner, f.task.ID, 1); return err })
	f.write(t, func(d store.AssistantTaskDAO) error { return d.DeleteTaskContent(ctx, f.owner, f.task.ID) })
	for _, table := range []string{"assistant_task_claim_operations", "assistant_task_inquiries", "assistant_task_events", "assistant_task_records", "assistant_task_items", "assistant_task_proposals", "assistant_task_appendix", "assistant_task_manual_versions"} {
		var count int
		if err := f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE task_id=$1`, f.task.ID).Scan(&count); err != nil || count != 0 {
			t.Fatalf("purge left %s rows: %d %v", table, count, err)
		}
	}
	f.write(t, func(d store.AssistantTaskDAO) error {
		_, err := d.Manual(ctx, f.owner, f.task.ID, 1)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("deleted manual visible: %v", err)
		}
		return nil
	})
}

func TestReceiptAndTaskRollbackTogether(t *testing.T) {
	f := setup(t)
	f.create(t)
	cause := errors.New("late admission rejected")
	op := model.AssistantTaskClaimOperation{OwnerUserID: f.owner, TaskID: f.task.ID, OperationID: uuid.NewString(), Kind: "claim", RequestFingerprint: "fingerprint", AdmittedAt: f.task.CreatedAt, ResultingVersion: 2, ResultingGeneration: 1}
	completion, err := f.db.WriteAssistantTask(t.Context(), func(s store.AssistantTaskScope) error {
		d := s.AssistantTaskDAO()
		candidate := f.task
		candidate.Version = 2
		candidate.ClaimGeneration = 1
		if ok, e := d.SaveTask(t.Context(), candidate, store.AssistantTaskCondition{Version: 1}); e != nil || !ok {
			return errors.Join(errors.New("CAS failed"), e)
		}
		if e := d.InsertClaimOperation(t.Context(), op); e != nil {
			return e
		}
		return cause
	})
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, cause) {
		t.Fatalf("rollback: %s %v", completion.Outcome, err)
	}
	f.write(t, func(d store.AssistantTaskDAO) error {
		got, e := d.Task(t.Context(), f.owner, f.task.ID, false)
		if e != nil {
			return e
		}
		if got.Version != 1 || got.ClaimGeneration != 0 {
			t.Fatal("rollback leaked task write")
		}
		_, e = d.ClaimOperation(t.Context(), f.owner, f.task.ID, op.OperationID)
		if !errors.Is(e, model.ErrNotFound) {
			t.Fatalf("rollback leaked receipt: %v", e)
		}
		return nil
	})
}
