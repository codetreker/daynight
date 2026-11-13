package assistanttask_test

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/assistanttask"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestClosedTransactionRetainsDriverCauseAcrossAccessPatterns(t *testing.T) {
	f := setup(t)
	ctx := t.Context()
	tx, err := f.db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	d := assistanttask.New(tx)
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	q := store.AssistantTaskQuery{OwnerUserID: f.owner, TaskID: f.task.ID, Limit: 1}
	id := uuid.NewString()
	checks := []struct {
		name string
		read func() error
	}{
		{"credential", func() error {
			return d.Credential(ctx, model.Principal{Kind: model.SessionCredential, UserID: f.owner, CredentialID: id})
		}},
		{"bot", func() error { _, e := d.Bot(ctx, id); return e }},
		{"time", func() error { _, e := d.Now(ctx); return e }},
		{"creation_lock", func() error { return d.LockCreation(ctx, id) }},
		{"task", func() error { _, e := d.Task(ctx, f.owner, f.task.ID, true); return e }},
		{"tasks", func() error { _, e := d.Tasks(ctx, q); return e }},
		{"insert", func() error { _, e := d.InsertTask(ctx, f.task); return e }},
		{"save", func() error { _, e := d.SaveTask(ctx, f.task, store.AssistantTaskCondition{}); return e }},
		{"purge", func() error { return d.DeleteTaskContent(ctx, f.owner, f.task.ID) }},
		{"manuals", func() error { _, e := d.Manuals(ctx, q); return e }},
		{"appendices", func() error { _, e := d.Appendices(ctx, q); return e }},
		{"proposals", func() error { _, e := d.Proposals(ctx, q); return e }},
		{"items", func() error { _, e := d.Items(ctx, q); return e }},
		{"records", func() error { _, e := d.Records(ctx, q); return e }},
		{"events", func() error { _, e := d.Events(ctx, q); return e }},
		{"inquiries", func() error { _, e := d.Inquiries(ctx, q); return e }},
		{"record_insert", func() error {
			_, e := d.InsertRecord(ctx, model.AssistantTaskRecord{OwnerUserID: f.owner, TaskID: f.task.ID})
			return e
		}},
	}
	for _, check := range checks {
		if err := check.read(); !errors.Is(err, pgx.ErrTxClosed) {
			t.Errorf("%s lost original driver cause: %v", check.name, err)
		}
	}
}

func TestMalformedStoredMaterialIsNotSkipped(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	id := uuid.NewString()
	if _, err := f.db.Pool.Exec(ctx, `INSERT INTO assistant_task_appendix(id,owner_user_id,task_id,text,state,request_fingerprint,source_records,version,created_at,updated_at) VALUES($1,$2,$3,'text','active','fp','{}',1,clock_timestamp(),clock_timestamp())`, id, f.owner, f.task.ID); err != nil {
		t.Fatal(err)
	}
	completion, err := f.db.WriteAssistantTask(ctx, func(s store.AssistantTaskScope) error {
		_, err := s.AssistantTaskDAO().Appendices(ctx, store.AssistantTaskQuery{OwnerUserID: f.owner, TaskID: f.task.ID, Limit: 200})
		return err
	})
	if err == nil || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("invalid stored array silently read: %#v %v", completion, err)
	}
}

func TestRecordClockExhaustionRollsBackWithoutInventedTimestamp(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	headID, id := uuid.NewString(), uuid.NewString()
	future := time.Now().UTC().Add(time.Hour).Truncate(time.Millisecond)
	if _, err := f.db.Pool.Exec(ctx, `UPDATE assistant_tasks SET record_last_created_at=$2,record_last_id=$3 WHERE id=$1`, f.task.ID, future, headID); err != nil {
		t.Fatal(err)
	}
	completion, err := f.db.WriteAssistantTask(ctx, func(s store.AssistantTaskScope) error {
		_, err := s.AssistantTaskDAO().InsertRecord(ctx, model.AssistantTaskRecord{ID: id, OwnerUserID: f.owner, TaskID: f.task.ID, Author: "user", Refs: json.RawMessage(`[]`)})
		return err
	})
	var clock *store.ThreadClockError
	if completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &clock) || !clock.Head.CreatedAt.Equal(future) || clock.Head.ID != headID {
		t.Fatalf("clock exhaustion: %#v %#v %v", completion, clock, err)
	}
	var count int
	var head time.Time
	if err := f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM assistant_task_records WHERE task_id=$1`, f.task.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("clock failure persisted a record: %d %v", count, err)
	}
	if err := f.db.Pool.QueryRow(ctx, `SELECT record_last_created_at FROM assistant_tasks WHERE id=$1`, f.task.ID).Scan(&head); err != nil || !head.Equal(future) {
		t.Fatalf("clock failure changed head: %s %v", head, err)
	}
}
