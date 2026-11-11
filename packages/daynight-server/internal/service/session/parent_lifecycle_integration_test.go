package session

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestParentDeletionPreservesWebArchiveAndUnknownCompletion(t *testing.T) {
	for _, mode := range []string{"unknown", "unknown_committed"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
			defer cancel()
			f := newServiceFixture(t)
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = files.Close() })
			engine := sessioncore.NewEngine(files)
			t.Cleanup(func() { _ = engine.Stop(context.Background()) })
			writer := &completionWriter{SessionWriter: f.db}
			f.service = New(writer, engine)
			goal := uuid.NewString()
			if _, err = f.db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title,status,type) VALUES($1,$2,'parent','in_progress','goal')`, goal, f.project); err != nil {
				t.Fatal(err)
			}
			if _, err = f.db.Pool.Exec(ctx, `UPDATE tasks SET parent_id=$1 WHERE id=$2`, goal, f.task); err != nil {
				t.Fatal(err)
			}
			current, err := f.service.Current(ctx, f.owner, f.project, goal)
			if err != nil || current["status"] != "not_applicable" {
				t.Fatalf("goal current: %v %v", current, err)
			}
			v := f.registerWeb(t)
			if _, err = f.db.Pool.Exec(ctx, `UPDATE tasks SET deleted_at=now() WHERE id=$1`, goal); err != nil {
				t.Fatal(err)
			}
			if _, err = f.service.Current(ctx, f.owner, f.project, f.task); err == nil {
				t.Fatal("hidden task current was readable")
			}
			if _, err = f.service.Register(ctx, f.owner, f.project, f.task, f.registration); err == nil {
				t.Fatal("hidden task registered")
			}
			if _, _, _, err = f.service.BrowserPoll(ctx, f.owner, f.project, f.task, v.SessionID, ""); err == nil {
				t.Fatal("hidden task session was readable")
			}
			op, err := f.service.BeginArchive(ctx, f.owner, f.project, f.task, v.SessionID, sessioncore.ArchiveV1Upload)
			if err != nil {
				t.Fatal(err)
			}
			request := sp.ArchivePrepareRequest{Fence: v.Fence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID}
			writer.inject(mode, nil)
			if _, err = op.PrepareArchive(ctx, request); !errors.Is(err, errInjectedCompletion) {
				t.Fatalf("unknown completion lost: %v", err)
			}
			if _, err = op.PrepareArchive(ctx, request); err != nil {
				t.Fatalf("prepare retry after observed unknown: %v", err)
			}
			if err = op.Close(); err != nil {
				t.Fatal(err)
			}
			data := prepareServiceArchive(t, ctx, f.service, f.owner, f.project, f.task, v)
			if err = publishServiceArchive(ctx, f.service, f.owner, f.project, f.task, v.SessionID, data); err != nil {
				t.Fatalf("owner archive: %v", err)
			}
			var state, taskStatus string
			if err = f.db.Pool.QueryRow(ctx, `SELECT a.state,t.status FROM session_archives a JOIN task_sessions s ON s.id=a.session_id JOIN tasks t ON t.id=s.task_id WHERE a.session_id=$1`, v.SessionID).Scan(&state, &taskStatus); err != nil || state != "ready" || taskStatus != "in_progress" {
				t.Fatalf("archive=%q task=%q err=%v", state, taskStatus, err)
			}
		})
	}
}

type heldRegistrationWriter struct {
	store.SessionWriter
	once             sync.Once
	entered, release chan struct{}
}

func (w *heldRegistrationWriter) WriteSession(ctx context.Context, work func(store.SessionScope) error) (store.Completion, error) {
	return w.SessionWriter.WriteSession(ctx, func(scope store.SessionScope) error {
		if err := work(scope); err != nil {
			return err
		}
		w.once.Do(func() { close(w.entered); <-w.release })
		return nil
	})
}

func TestTwoRealSessionRegistrationsSerialize(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	f := newServiceFixture(t)
	goal := uuid.NewString()
	if _, err := f.db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title,status,type) VALUES($1,$2,'parent','todo','goal')`, goal, f.project); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(ctx, `UPDATE tasks SET parent_id=$1 WHERE id=$2`, goal, f.task); err != nil {
		t.Fatal(err)
	}
	writer := &heldRegistrationWriter{SessionWriter: f.db, entered: make(chan struct{}), release: make(chan struct{})}
	var release sync.Once
	releaseFirst := func() { release.Do(func() { close(writer.release) }) }
	t.Cleanup(releaseFirst)
	engine := sessioncore.NewEngine(nil)
	t.Cleanup(func() { _ = engine.Stop(context.Background()) })
	service := New(writer, engine)
	type result struct {
		snapshot sp.Snapshot
		err      error
	}
	first, second := make(chan result, 1), make(chan result, 1)
	go func() {
		v, err := service.Register(ctx, f.owner, f.project, f.task, f.registration)
		first <- result{v, err}
	}()
	select {
	case <-writer.entered:
	case result := <-first:
		t.Fatalf("first registration did not hold transaction: %v", result.err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	go func() {
		v, err := service.Register(ctx, f.owner, f.project, f.task, f.registration)
		second <- result{v, err}
	}()
	if err := waitArchiveLock(ctx, f.db, "SELECT id::text FROM tasks WHERE project_id=$1 AND id=$2 FOR UPDATE"); err != nil {
		t.Fatal(err)
	}
	releaseFirst()
	a, b := <-first, <-second
	if a.err != nil || b.err != nil || a.snapshot.SessionID == "" || a.snapshot.SessionID != b.snapshot.SessionID {
		t.Fatalf("registrations failed idempotency after waiting: %+v %+v", a, b)
	}
	var count int
	if err := f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_sessions WHERE task_id=$1`, f.task).Scan(&count); err != nil || count != 1 {
		t.Fatalf("persisted registrations=%d %v", count, err)
	}
}

func TestParentDeletionPreservesTerminalArchiveAndUnknownCompletion(t *testing.T) {
	for _, mode := range []string{"unknown", "unknown_committed"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
			defer cancel()
			f := newServiceFixture(t)
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = files.Close() })
			engine := sessioncore.NewEngine(files)
			t.Cleanup(func() { _ = engine.Stop(context.Background()) })
			writer := &completionWriter{SessionWriter: f.db}
			f.service = New(writer, engine)
			goal := uuid.NewString()
			if _, err = f.db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title,status,type) VALUES($1,$2,'parent','in_progress','goal')`, goal, f.project); err != nil {
				t.Fatal(err)
			}
			if _, err = f.db.Pool.Exec(ctx, `UPDATE tasks SET parent_id=$1 WHERE id=$2`, goal, f.task); err != nil {
				t.Fatal(err)
			}
			id, data := readyTerminalArchiveWithDeletion(t, f, func(id string) {
				if _, err := f.db.Pool.Exec(ctx, `UPDATE tasks SET deleted_at=now() WHERE id=$1`, goal); err != nil {
					t.Fatal(err)
				}
				if _, err := f.service.TerminalState(ctx, f.owner, f.project, f.task, id); err == nil {
					t.Fatal("hidden terminal state was readable")
				}
			}, writer, mode)
			if _, err = f.service.PutTerminalArchive(ctx, f.owner, f.project, f.task, id, data); err != nil {
				t.Fatalf("owner terminal archive: %v", err)
			}
			var state, taskStatus string
			if err = f.db.Pool.QueryRow(ctx, `SELECT a.state,t.status FROM session_archives a JOIN task_sessions s ON s.id=a.session_id JOIN tasks t ON t.id=s.task_id WHERE a.session_id=$1`, id).Scan(&state, &taskStatus); err != nil || state != "ready" || taskStatus != "in_progress" {
				t.Fatalf("archive=%q task=%q err=%v", state, taskStatus, err)
			}
		})
	}
}
