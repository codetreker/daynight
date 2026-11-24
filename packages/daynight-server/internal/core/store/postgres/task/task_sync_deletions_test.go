package task_test

import (
	"context"
	"errors"
	"io"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskdao "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/jackc/pgx/v5"
)

func TestTaskSyncDeletionsStore(t *testing.T) {
	suite := newTaskStoreSuite(t)
	suite.run(t, "WindowCoverageAndSnapshot", testTaskSyncDeletionsWindowCoverageAndSnapshot)
	suite.run(t, "Cancellation", testTaskSyncDeletionsCancellation)
}

func testTaskSyncDeletionsWindowCoverageAndSnapshot(t *testing.T, db *postgres.Store) {
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	project := readerProject(t, db, 1)
	other := readerProject(t, db, 2)
	empty := readerProject(t, db, 3)
	root := readerTask(t, db, project.ID, 10, model.TaskTodo)
	child := readerTask(t, db, project.ID, 11, model.TaskTodo)
	old := readerTask(t, db, project.ID, 12, model.TaskTodo)
	live := readerTask(t, db, project.ID, 13, model.TaskTodo)
	foreign := readerTask(t, db, other.ID, 14, model.TaskTodo)
	stamp := time.Date(2026, 1, 2, 0, 0, 0, 123456000, time.UTC)
	previous := stamp.Add(-time.Hour)
	readerExec(t, db, `UPDATE tasks SET updated_at=$2,deleted_at=$2 WHERE id=$1`, root.ID, stamp)
	readerExec(t, db, `UPDATE tasks SET updated_at=$2,ancestor_deleted_at=$3 WHERE id=$1`, child.ID, previous, stamp)
	readerExec(t, db, `UPDATE tasks SET updated_at=$2,deleted_at=$2 WHERE id=$1`, old.ID, previous)
	readerExec(t, db, `UPDATE tasks SET updated_at=$2 WHERE id=$1`, live.ID, previous)
	readerExec(t, db, `UPDATE tasks SET updated_at=$2,deleted_at=$2 WHERE id=$1`, foreign.ID, stamp.Add(time.Hour))
	tx, err := db.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	mustOK(t, err)
	defer tx.Rollback(context.Background())
	reader := taskdao.NewReader(tx).(*taskdao.Reader)
	coverage, err := reader.TaskSyncCoverageUpdatedAt(ctx, project.ID)
	mustOK(t, err)
	if coverage == nil || !coverage.Equal(stamp) || coverage.Location() != time.UTC {
		t.Fatalf("coverage: %v", coverage)
	}
	none, err := reader.TaskSyncCoverageUpdatedAt(ctx, empty.ID)
	mustOK(t, err)
	if none != nil {
		t.Fatalf("empty coverage: %v", none)
	}
	for _, c := range []struct {
		lower *time.Time
		want  []string
	}{
		{nil, []string{root.ID, child.ID, old.ID}},
		{&stamp, []string{root.ID, child.ID}},
		{ptrTime(stamp.Add(time.Nanosecond)), []string{}},
		{&previous, []string{root.ID, child.ID, old.ID}},
	} {
		got, err := reader.TaskSyncDeletedTaskIDs(ctx, project.ID, c.lower)
		mustOK(t, err)
		if !reflect.DeepEqual(got, c.want) {
			t.Fatalf("lower %v: got %v want %v", c.lower, got, c.want)
		}
	}
	ids, err := reader.TaskSyncDeletedTaskIDs(ctx, empty.ID, nil)
	mustOK(t, err)
	if ids == nil || len(ids) != 0 {
		t.Fatalf("empty IDs: %#v", ids)
	}
	// A later commit cannot change either observation of the established snapshot.
	readerExec(t, db, `UPDATE tasks SET updated_at=$2,deleted_at=$2 WHERE id=$1`, live.ID, stamp.Add(time.Hour))
	again, err := reader.TaskSyncCoverageUpdatedAt(ctx, project.ID)
	mustOK(t, err)
	ids, err = reader.TaskSyncDeletedTaskIDs(ctx, project.ID, &stamp)
	mustOK(t, err)
	if again == nil || !again.Equal(stamp) || !reflect.DeepEqual(ids, []string{root.ID, child.ID}) {
		t.Fatalf("snapshot changed: %v %v", again, ids)
	}
	mustOK(t, tx.Rollback(ctx))
	tx2, err := db.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	mustOK(t, err)
	defer tx2.Rollback(context.Background())
	fresh := taskdao.NewReader(tx2).(*taskdao.Reader)
	coverage, err = fresh.TaskSyncCoverageUpdatedAt(ctx, project.ID)
	mustOK(t, err)
	ids, err = fresh.TaskSyncDeletedTaskIDs(ctx, project.ID, &stamp)
	mustOK(t, err)
	if coverage == nil || !coverage.Equal(stamp.Add(time.Hour)) || !reflect.DeepEqual(ids, []string{root.ID, child.ID, live.ID}) {
		t.Fatalf("fresh snapshot: %v %v", coverage, ids)
	}
}

func ptrTime(v time.Time) *time.Time { return &v }

func testTaskSyncDeletionsCancellation(t *testing.T, db *postgres.Store) {
	tx, err := db.Pool.Begin(t.Context())
	mustOK(t, err)
	defer tx.Rollback(context.Background())
	reader := taskdao.NewReader(tx).(*taskdao.Reader)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	coverage, err := reader.TaskSyncCoverageUpdatedAt(ctx, readerID(1))
	if !errors.Is(err, context.Canceled) || coverage != nil {
		t.Fatalf("coverage cancellation: %v %v", coverage, err)
	}
	ids, err := reader.TaskSyncDeletedTaskIDs(ctx, readerID(1), nil)
	if !errors.Is(err, context.Canceled) || ids != nil {
		t.Fatalf("deletions cancellation: %v %v", ids, err)
	}
}

func TestTaskSyncDeletedIDsDiscardIncompleteResults(t *testing.T) {
	f := newFixture(t)
	row := mustTask(t, taskdao.NewWriter(f.tx, f.project), store.TaskWrite{Title: "Deleted"})
	_, err := f.tx.Exec(t.Context(), `UPDATE tasks SET deleted_at=now() WHERE id=$1`, row.ID)
	mustOK(t, err)
	for _, scanFailure := range []bool{false, true} {
		reader := taskdao.NewReader(&interruptedTx{Tx: f.tx, target: 1, scanFailure: scanFailure}).(*taskdao.Reader)
		ids, err := reader.TaskSyncDeletedTaskIDs(t.Context(), f.project, nil)
		if ids != nil || !errors.Is(err, io.ErrUnexpectedEOF) {
			t.Fatalf("stream failure returned partial data or lost cause: %v, %v", ids, err)
		}
	}
}
