package task

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

func TestTaskFactsOnlyActualChanges(t *testing.T) {
	now := time.Date(2026, 11, 6, 8, 0, 0, 123000, time.UTC)
	old := model.Task{ID: "33333333-3333-4333-8333-333333333333", ProjectID: "22222222-2222-4222-8222-222222222222", Status: model.TaskTodo, Version: 1, CreatedAt: now, UpdatedAt: now, Properties: model.TaskProperties{}}
	current := old
	current.Version = 2
	current.UpdatedAt = now.Add(time.Second)
	current.Status = model.TaskInProgress
	current.Properties = model.TaskProperties{"paused": json.RawMessage(`true`)}
	facts, err := taskFacts(false, old, current)
	if err != nil || len(facts) != 2 || facts[0].Type != protocol.StatusChanged || facts[1].Type != protocol.Paused || facts[0].TaskVersion != 2 || !facts[0].OccurredAt.Equal(current.UpdatedAt) {
		t.Fatalf("combined: %#v %v", facts, err)
	}
	for _, f := range facts {
		if _, err = protocol.Render("a0be4d96-fb33-41ba-a7bd-7885c1e94247", f); err != nil {
			t.Fatal(err)
		}
	}
	created, err := taskFacts(true, model.Task{}, current)
	if err != nil || len(created) != 1 || created[0].Type != protocol.Created || !created[0].Paused || !created[0].OccurredAt.Equal(now) {
		t.Fatalf("created: %#v %v", created, err)
	}
	facts, err = taskFacts(false, current, current)
	if err != nil || len(facts) != 0 {
		t.Fatalf("unchanged: %#v %v", facts, err)
	}
	next := current
	next.Properties = model.TaskProperties{"paused": json.RawMessage(`false`)}
	facts, err = taskFacts(false, current, next)
	if err != nil || len(facts) != 0 {
		t.Fatalf("unpaused: %#v %v", facts, err)
	}
	next.Properties = model.TaskProperties{"paused": json.RawMessage(`"true"`)}
	if _, err = taskFacts(false, current, next); err == nil {
		t.Fatal("paused JSON type error was hidden")
	}
}

type stepCaptureScope struct {
	store.ProjectWriteScope
	dao     store.TaskWriteDAO
	capture store.WebhookCaptureDAO
}

func (s stepCaptureScope) TaskDAO() store.TaskWriteDAO         { return s.dao }
func (s stepCaptureScope) CaptureDAO() store.WebhookCaptureDAO { return s.capture }

type stepCaptureDAO struct {
	store.TaskWriteDAO
	t      *testing.T
	ctx    context.Context
	taskID string
	header model.TaskHeader
	calls  int
}

func (d *stepCaptureDAO) TaskHeader(ctx context.Context, taskID string) (model.TaskHeader, error) {
	d.t.Helper()
	if ctx != d.ctx || taskID != d.taskID || d.calls != 0 {
		d.t.Fatal("Step capture read a different Task or escaped its source context")
	}
	d.calls++
	return d.header, nil
}

type recordedCapture struct {
	t     *testing.T
	ctx   context.Context
	dao   store.WebhookCaptureDAO
	facts []protocol.Fact
	cause error
}

func (r *recordedCapture) CaptureBatch(ctx context.Context, dao store.WebhookCaptureDAO, f []protocol.Fact) error {
	r.t.Helper()
	if ctx != r.ctx || dao != r.dao || len(r.facts) != 0 {
		r.t.Fatal("Step capture escaped its source context or transaction DAO")
	}
	r.facts = append(r.facts, f...)
	return r.cause
}

func TestStepCaptureUsesFinalRevisionAndLogicalAction(t *testing.T) {
	ctx := t.Context()
	taskID := "33333333-3333-4333-8333-333333333333"
	marker := &sourceCaptureDAO{}
	dao := &stepCaptureDAO{t: t, ctx: ctx, taskID: taskID, header: model.TaskHeader{Version: 21}}
	record := &recordedCapture{t: t, ctx: ctx, dao: marker}
	s := &TaskSteps{capturer: record}
	scope := stepCaptureScope{dao: dao, capture: marker}
	before := model.TaskStep{Status: model.TaskStepTodo, Title: "before", Description: "before"}
	after := model.TaskStep{Status: model.TaskStepDone, Title: "after", Description: "after"}
	now := sampleTimeForTaskTest()
	err := s.captureStep(ctx, scope, "22222222-2222-4222-8222-222222222222", taskID, "abcdef01", "updated", now, nil, nil, &before, &after)
	if err != nil || len(record.facts) != 1 || dao.calls != 1 {
		t.Fatalf("capture: %v %#v", err, record.facts)
	}
	f := record.facts[0]
	if f.TaskVersion != 21 || f.Action != "status_changed" || f.PreviousStatus != "todo" || f.Status != "done" || len(f.ChangedFields) != 2 || f.ChangedFields[0] != "description" || f.ChangedFields[1] != "title" {
		t.Fatalf("fact: %#v", f)
	}
	if _, err = protocol.Render("a0be4d96-fb33-41ba-a7bd-7885c1e94247", f); err != nil {
		t.Fatal(err)
	}
}
func sampleTimeForTaskTest() time.Time { return time.Date(2026, 11, 6, 8, 0, 0, 0, time.UTC) }
