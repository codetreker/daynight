package task_test

import (
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/google/uuid"
	"reflect"
	"testing"
	"time"
)

func TestThreadDAOAppendTraversalAndCredentialReadback(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	w := task.NewWriter(f.tx, f.project)
	r := task.NewReader(f.tx)
	d := task.NewThreadDAO(f.tx)
	a := mustTask(t, w, store.TaskWrite{Title: "thread"})
	other := mustTask(t, w, store.TaskWrite{Title: "other"})
	presence, e := d.LockTaskPresence(ctx, f.project, a.ID)
	mustOK(t, e)
	if !presence.Found || presence.DeletedAt != nil {
		t.Fatalf("presence: %+v", presence)
	}
	name, e := d.AuthorName(ctx, f.user)
	mustOK(t, e)
	if name == nil || *name != "Author" {
		t.Fatalf("author: %v", name)
	}
	source, e := d.SourceTask(ctx, f.project, a.ID)
	mustOK(t, e)
	if source.Status != model.TaskTodo || len(source.Properties) != 0 {
		t.Fatalf("source: %+v", source)
	}
	credentialID := uuid.NewString()
	_, e = f.tx.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES($1,$2,$3,'thread',now())`, credentialID, f.user, make([]byte, 32))
	mustOK(t, e)
	credential, e := d.Credential(ctx, model.Principal{Kind: model.PATCredential, UserID: f.user, CredentialID: credentialID})
	mustOK(t, e)
	if credential.ExpiresAt != nil {
		t.Fatal("nonexpiring PAT changed")
	}
	past, future := time.Now().Add(-time.Hour), time.Now().Add(time.Hour)
	for _, v := range []struct {
		expires *time.Time
		want    bool
	}{{nil, true}, {&past, false}, {&future, true}} {
		valid, e := d.CredentialValid(ctx, store.ThreadCredential{ExpiresAt: v.expires})
		mustOK(t, e)
		if valid != v.want {
			t.Fatalf("valid=%v expiry=%v", valid, v.expires)
		}
	}
	head, e := d.LockHead(ctx, a.ID)
	mustOK(t, e)
	if head != nil {
		t.Fatal("new head is not empty")
	}
	messages := []model.ThreadMessage{}
	for i := range 3 {
		input := model.ThreadMessage{TaskID: a.ID, Author: model.ThreadAuthor{UserID: f.user, DisplayName: name}, Body: []string{"first", "second", "third"}[i]}
		if i > 0 {
			input.ReplyTo = &messages[0].ID
		}
		if i == 2 {
			input.Author.Agent = true
			input.Author.Execution = &model.ThreadExecution{ClaimID: uuid.NewString(), WorkerID: uuid.NewString(), Provider: "codex"}
		}
		message, e := d.InsertMessage(ctx, input)
		mustOK(t, e)
		if message.ID == "" || message.CreatedAt.IsZero() || message.Body != input.Body || !reflect.DeepEqual(message.Author, input.Author) {
			t.Fatalf("inserted: %+v", message)
		}
		mustOK(t, d.PrepareTimestamp(ctx, &message, head))
		mustOK(t, d.AdvanceHead(ctx, a.ID, message.Position()))
		p := message.Position()
		head = &p
		messages = append(messages, message)
	}
	locked, e := d.LockHead(ctx, a.ID)
	mustOK(t, e)
	if !reflect.DeepEqual(locked, head) {
		t.Fatalf("locked head: %+v", locked)
	}
	for _, read := range []func() (model.ThreadMessage, error){func() (model.ThreadMessage, error) { return d.ThreadMessage(ctx, a.ID, messages[2].ID) }, func() (model.ThreadMessage, error) { return r.ThreadMessage(ctx, a.ID, messages[2].ID) }} {
		got, e := read()
		mustOK(t, e)
		if !reflect.DeepEqual(got, messages[2]) {
			t.Fatalf("message readback: %+v", got)
		}
	}
	all, e := r.ThreadCandidates(ctx, a.ID, nil, false, 2)
	mustOK(t, e)
	if len(all) != 2 || all[0].ID != messages[0].ID || all[1].ID != messages[1].ID {
		t.Fatalf("forward candidates: %+v", all)
	}
	anchor := messages[2].Position()
	before, e := r.ThreadCandidates(ctx, a.ID, &anchor, true, 2)
	mustOK(t, e)
	if len(before) != 2 || before[0].ID != messages[1].ID || before[1].ID != messages[0].ID {
		t.Fatalf("backward candidates: %+v", before)
	}
	left, right, e := r.ThreadSides(ctx, a.ID, messages[1].Position(), messages[1].Position())
	mustOK(t, e)
	if !left || !right {
		t.Fatal("middle page sides missing")
	}
	left, right, e = r.ThreadSides(ctx, a.ID, messages[0].Position(), messages[2].Position())
	mustOK(t, e)
	if left || right {
		t.Fatal("full page has extra sides")
	}
	if _, e = r.ThreadMessage(ctx, other.ID, messages[0].ID); !errors.Is(e, model.ErrNotFound) {
		t.Fatalf("cross-task message: %v", e)
	}
	if e = d.AdvanceHead(ctx, a.ID, messages[0].Position()); e == nil {
		t.Fatal("thread head moved backwards")
	}
	candidate, e := d.InsertMessage(ctx, model.ThreadMessage{TaskID: a.ID, Author: model.ThreadAuthor{UserID: f.user}, Body: "recovered"})
	mustOK(t, e)
	candidate.CreatedAt = messages[0].CreatedAt.Add(-time.Hour)
	mustOK(t, d.PrepareTimestamp(ctx, &candidate, head))
	if !candidate.CreatedAt.After(head.CreatedAt) {
		t.Fatalf("recovery timestamp: %v <= %v", candidate.CreatedAt, head.CreatedAt)
	}
	mustOK(t, d.AdvanceHead(ctx, a.ID, candidate.Position()))
	mustOK(t, f.tx.Commit(ctx))
	var count int
	mustOK(t, f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_thread_messages WHERE task_id=$1`, a.ID).Scan(&count))
	if count != 4 {
		t.Fatalf("persisted messages: %d", count)
	}
}
