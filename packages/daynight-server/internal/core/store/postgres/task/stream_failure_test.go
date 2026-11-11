package task_test

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// A streaming driver can fail after Query succeeds. Retain the real query and
// rows so these probes exercise each DAO's handling of incomplete results.
type interruptedRows struct {
	pgx.Rows
	scanFailure bool
	exhausted   bool
}

func (r *interruptedRows) Scan(dest ...any) error {
	if r.scanFailure {
		return io.ErrUnexpectedEOF
	}
	return r.Rows.Scan(dest...)
}
func (r *interruptedRows) Next() bool {
	if r.exhausted {
		r.Rows.Close()
		return false
	}
	ok := r.Rows.Next()
	if ok {
		r.exhausted = true
	}
	return ok
}
func (r *interruptedRows) Err() error {
	if e := r.Rows.Err(); e != nil {
		return e
	}
	return io.ErrUnexpectedEOF
}

type interruptedTx struct {
	pgx.Tx
	scanFailure        bool
	queryIndex, target int
	rejectQuery        bool
}

func (tx *interruptedTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	tx.queryIndex++
	if tx.queryIndex != tx.target {
		return tx.Tx.Query(ctx, sql, args...)
	}
	if tx.rejectQuery {
		return nil, io.ErrUnexpectedEOF
	}
	rows, e := tx.Tx.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	return &interruptedRows{Rows: rows, scanFailure: tx.scanFailure}, nil
}

func TestDAOStreamingFailuresDiscardIncompleteResults(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	w := task.NewWriter(f.tx, f.project)
	a := mustTask(t, w, store.TaskWrite{Title: "stream alpha"})
	b := mustTask(t, w, store.TaskWrite{Title: "dependent", Status: model.TaskInProgress, DependsOn: []string{a.ID}})
	goal := uuid.NewString()
	_, err := f.tx.Exec(ctx, `INSERT INTO tasks(id,project_id,type,title) VALUES($1,$2,'goal','goal')`, goal, f.project)
	mustOK(t, err)
	stamp := time.Now().UTC()
	mustOK(t, w.InsertTaskStep(ctx, a.ID, model.TaskStep{ID: "00000001", Title: "step", Status: model.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp}))
	_, e := task.NewThreadDAO(f.tx).InsertMessage(ctx, model.ThreadMessage{TaskID: a.ID, Author: model.ThreadAuthor{UserID: f.user}, Body: "message"})
	mustOK(t, e)
	tests := map[string]func(pgx.Tx) error{
		"tasks": func(tx pgx.Tx) error {
			v, e := task.NewReader(tx).Tasks(ctx, f.project, store.TaskQuery{Page: store.Page{Limit: 10}})
			if e != nil && len(v.Items) != 0 {
				t.Fatal("partial task list escaped")
			}
			return e
		},
		"priority": func(tx pgx.Tx) error {
			v, e := task.NewReader(tx).TaskPriorityList(ctx, f.project, store.TaskPriorityQuery{Limit: 10})
			if e != nil && len(v.Items) != 0 {
				t.Fatal("partial priority list escaped")
			}
			return e
		},
		"graph": func(tx pgx.Tx) error {
			v, e := task.NewReader(tx).TaskGraphTasks(ctx, f.project, a.ID, store.TaskGraphSelection{OrdinaryDependents: true}, 10)
			if e != nil && v != nil {
				t.Fatal("partial graph escaped")
			}
			return e
		},
		"sync": func(tx pgx.Tx) error {
			v, e := task.NewReader(tx).TaskSyncTasks(ctx, f.project, nil, 10)
			if e != nil && v != nil {
				t.Fatal("partial sync escaped")
			}
			return e
		},
		"assignees": func(tx pgx.Tx) error {
			v, e := task.NewReader(tx).TaskAssignees(ctx, f.project)
			if e != nil && v != nil {
				t.Fatal("partial assignees escaped")
			}
			return e
		},
		"resolve": func(tx pgx.Tx) error {
			v, e := task.NewReader(tx).ResolveTaskAssignees(ctx, f.project, []string{f.user})
			if e != nil && v != nil {
				t.Fatal("partial resolved assignees escaped")
			}
			return e
		},
		"step page": func(tx pgx.Tx) error {
			v, e := task.NewReader(tx).TaskStepPage(ctx, a.ID, -1, 10, false)
			if e != nil && v != nil {
				t.Fatal("partial steps escaped")
			}
			return e
		},
		"candidates": func(tx pgx.Tx) error {
			v, e := task.NewReader(tx).ThreadCandidates(ctx, a.ID, nil, false, 10)
			if e != nil && v != nil {
				t.Fatal("partial messages escaped")
			}
			return e
		},
		"search graph": func(tx pgx.Tx) error {
			_, e := task.NewSearchSnapshot(tx).ContextGraph(ctx, f.project, []string{a.ID})
			return e
		},
		"search titles": func(tx pgx.Tx) error {
			v, e := task.NewSearchSnapshot(tx).Titles(ctx, f.project, []string{goal})
			if e != nil && v != nil {
				t.Fatal("partial titles escaped")
			}
			return e
		},
		"search matches": func(tx pgx.Tx) error {
			v, e := task.NewSearchSnapshot(tx).Matches(ctx, f.project, store.TaskSearchQuery{Expression: atom(0, "alpha"), Limit: 10})
			if e != nil && len(v.Items) != 0 {
				t.Fatal("partial matches escaped")
			}
			return e
		},
		"tasks by ID": func(tx pgx.Tx) error {
			v, e := task.NewWriter(tx, f.project).TasksByID(ctx, []string{a.ID, b.ID})
			if e != nil && v != nil {
				t.Fatal("partial prerequisites escaped")
			}
			return e
		},
		"active dependents": func(tx pgx.Tx) error { _, e := task.NewWriter(tx, f.project).ActiveDependentIDs(ctx, a.ID); return e },
		"dependents":        func(tx pgx.Tx) error { _, e := task.NewWriter(tx, f.project).DependentIDs(ctx, a.ID); return e },
	}
	for name, check := range tests {
		for _, scan := range []bool{false, true} {
			mode := "stream"
			if scan {
				mode = "scan"
			}
			t.Run(name+"/"+mode, func(t *testing.T) {
				e := check(&interruptedTx{Tx: f.tx, target: 1, scanFailure: scan})
				if !errors.Is(e, io.ErrUnexpectedEOF) {
					t.Fatalf("driver failure lost: %v", e)
				}
				failed, _ := store.DatabaseErrorFacts(e)
				if !failed {
					t.Fatalf("driver failure classification lost: %v", e)
				}
			})
		}
	}
	for _, mode := range []string{"query", "scan", "stream"} {
		t.Run("search edges/"+mode, func(t *testing.T) {
			_, e := task.NewSearchSnapshot(&interruptedTx{Tx: f.tx, target: 2, scanFailure: mode == "scan", rejectQuery: mode == "query"}).ContextGraph(ctx, f.project, []string{a.ID})
			if !errors.Is(e, io.ErrUnexpectedEOF) {
				t.Fatalf("edge failure lost: %v", e)
			}
		})
	}
	t.Run("sync properties", func(t *testing.T) {
		_, e := task.NewReader(&interruptedTx{Tx: f.tx, target: 2, rejectQuery: true}).TaskSyncTasks(ctx, f.project, nil, 10)
		if !errors.Is(e, io.ErrUnexpectedEOF) {
			t.Fatalf("property failure lost: %v", e)
		}
	})
	t.Run("list properties", func(t *testing.T) {
		_, e := task.NewReader(&interruptedTx{Tx: f.tx, target: 2, rejectQuery: true}).Tasks(ctx, f.project, store.TaskQuery{Page: store.Page{Limit: 10}})
		if !errors.Is(e, io.ErrUnexpectedEOF) {
			t.Fatalf("property failure lost: %v", e)
		}
	})
	t.Run("prerequisite properties", func(t *testing.T) {
		_, e := task.NewWriter(&interruptedTx{Tx: f.tx, target: 2, rejectQuery: true}, f.project).TasksByID(ctx, []string{a.ID})
		if !errors.Is(e, io.ErrUnexpectedEOF) {
			t.Fatalf("property failure lost: %v", e)
		}
	})
}
