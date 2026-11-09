package task_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/jackc/pgx/v5"
)

func TestDAOsPropagateTransactionClosure(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	w := task.NewWriter(f.tx, f.project)
	a := mustTask(t, w, store.TaskWrite{Title: "closed transaction"})
	mustOK(t, f.tx.Rollback(ctx))
	r := task.NewReader(f.tx)
	s := task.NewSearchSnapshot(f.tx)
	d := task.NewThreadDAO(f.tx)
	position := model.ThreadPosition{CreatedAt: time.Now().UTC(), ID: a.ID}
	step := model.TaskStep{ID: "00000001"}
	checks := map[string]func() error{
		"task":          func() error { _, e := r.Task(ctx, f.project, a.ID); return e },
		"tasks":         func() error { _, e := r.Tasks(ctx, f.project, store.TaskQuery{Page: store.Page{Limit: 1}}); return e },
		"fence":         func() error { _, e := r.TaskListFence(ctx, f.project); return e },
		"priority":      func() error { _, e := r.TaskPriorityList(ctx, f.project, store.TaskPriorityQuery{Limit: 1}); return e },
		"presence":      func() error { _, e := r.TaskPresence(ctx, f.project, a.ID); return e },
		"header":        func() error { _, e := r.TaskHeader(ctx, f.project, a.ID); return e },
		"step":          func() error { _, e := r.TaskStep(ctx, a.ID, step.ID); return e },
		"steps":         func() error { _, e := r.TaskSteps(ctx, a.ID); return e },
		"step page":     func() error { _, e := r.TaskStepPage(ctx, a.ID, -1, 1, false); return e },
		"step summary":  func() error { _, e := r.TaskStepSummary(ctx, a.ID, step.ID); return e },
		"message":       func() error { _, e := r.ThreadMessage(ctx, a.ID, a.ID); return e },
		"candidates":    func() error { _, e := r.ThreadCandidates(ctx, a.ID, nil, false, 1); return e },
		"sides":         func() error { _, _, e := r.ThreadSides(ctx, a.ID, position, position); return e },
		"assignees":     func() error { _, e := r.TaskAssignees(ctx, f.project); return e },
		"resolve":       func() error { _, e := r.ResolveTaskAssignees(ctx, f.project, []string{f.user}); return e },
		"graph tasks":   func() error { _, e := r.TaskGraphTasks(ctx, f.project, a.ID, store.TaskGraphSelection{}, 10); return e },
		"epoch":         func() error { _, e := r.TaskCacheEpoch(ctx, f.project); return e },
		"sync":          func() error { _, e := r.TaskSyncTasks(ctx, f.project, nil, 10); return e },
		"search fence":  func() error { _, e := s.Fence(ctx, f.project); return e },
		"search graph":  func() error { _, e := s.ContextGraph(ctx, f.project, []string{a.ID}); return e },
		"search titles": func() error { _, e := s.Titles(ctx, f.project, []string{a.ID}); return e },
		"search matches": func() error {
			_, e := s.Matches(ctx, f.project, store.TaskSearchQuery{Expression: atom(0, "closed"), Limit: 1})
			return e
		},
		"locked task":       func() error { _, e := w.Task(ctx, a.ID); return e },
		"tasks by ID":       func() error { _, e := w.TasksByID(ctx, []string{a.ID}); return e },
		"active dependents": func() error { _, e := w.ActiveDependentIDs(ctx, a.ID); return e },
		"dependents":        func() error { _, e := w.DependentIDs(ctx, a.ID); return e },
		"reachability": func() error {
			_, e := w.Reachable(ctx, a.ID, a.ID, store.DependencyReplacement{TaskID: a.ID})
			return e
		},
		"create":              func() error { _, e := w.CreateTask(ctx, a.ID, store.TaskWrite{Status: model.TaskTodo}); return e },
		"update":              func() error { _, e := w.UpdateTask(ctx, a.ID, store.TaskWrite{Status: model.TaskTodo}); return e },
		"clock":               func() error { _, e := w.ObservedAt(ctx); return e },
		"delete":              func() error { _, e := w.DeleteTask(ctx, a.ID, false); return e },
		"delete dependencies": func() error { _, e := w.DeleteTask(ctx, a.ID, true); return e },
		"write header":        func() error { _, e := w.TaskHeader(ctx, a.ID); return e },
		"write steps":         func() error { _, e := w.TaskSteps(ctx, a.ID); return e },
		"insert step":         func() error { return w.InsertTaskStep(ctx, a.ID, step) },
		"touch":               func() error { return w.TouchTask(ctx, a.ID, time.Now()) },
		"update step":         func() error { return w.UpdateTaskStep(ctx, a.ID, step) },
		"move step":           func() error { return w.MoveTaskStep(ctx, a.ID, step.ID, 0, 1) },
		"delete step":         func() error { return w.DeleteTaskStep(ctx, a.ID, step.ID, 0, 0) },
		"lock presence":       func() error { _, e := d.LockTaskPresence(ctx, f.project, a.ID); return e },
		"credential": func() error {
			_, e := d.Credential(ctx, model.Principal{Kind: model.PATCredential, UserID: f.user, CredentialID: a.ID})
			return e
		},
		"author":        func() error { _, e := d.AuthorName(ctx, f.user); return e },
		"source":        func() error { _, e := d.SourceTask(ctx, f.project, a.ID); return e },
		"lock head":     func() error { _, e := d.LockHead(ctx, a.ID); return e },
		"write message": func() error { _, e := d.ThreadMessage(ctx, a.ID, a.ID); return e },
		"insert message": func() error {
			_, e := d.InsertMessage(ctx, model.ThreadMessage{TaskID: a.ID, Author: model.ThreadAuthor{UserID: f.user}})
			return e
		},
		"credential expiry": func() error { _, e := d.CredentialValid(ctx, store.ThreadCredential{}); return e },
		"advance head":      func() error { return d.AdvanceHead(ctx, a.ID, position) },
	}
	for name, check := range checks {
		t.Run(name, func(t *testing.T) {
			e := check()
			if e == nil {
				t.Fatal("closed transaction succeeded")
			}
			if !errors.Is(e, pgx.ErrTxClosed) {
				t.Fatalf("transaction cause lost: %v", e)
			}
			if errors.Is(e, model.ErrNotFound) {
				t.Fatalf("transaction failure became not found: %v", e)
			}
			failed, _ := store.DatabaseErrorFacts(e)
			if !failed {
				t.Fatalf("transaction failure lost database classification: %v", e)
			}
		})
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	message := model.ThreadMessage{TaskID: a.ID, ID: a.ID, CreatedAt: position.CreatedAt.Add(-time.Hour)}
	if e := d.PrepareTimestamp(canceled, &message, &position); !errors.Is(e, context.Canceled) {
		t.Fatalf("timestamp parent cancellation: %v", e)
	}
}
