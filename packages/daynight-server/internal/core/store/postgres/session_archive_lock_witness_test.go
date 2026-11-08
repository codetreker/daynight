package postgres

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	pgtask "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/google/uuid"
)

func sessionArchiveLockFixture(t *testing.T) (*Store, model.Task, string) {
	t.Helper()
	database := isolatedStore(t)
	_, owner, _ := testAuthRecords(t, database)
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 2, model.TaskDone)
	id, claim := uuid.NewString(), uuid.NewString()
	sessionDAOTransaction(t, database, func(scope store.SessionScope) error {
		return scope.SessionDAO().InsertTaskSession(t.Context(), store.SessionRegistration{
			Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: task.ID},
			ClaimID:  claim, OwnerID: owner.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`),
			Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: "1"}}, Lifecycle: "archived"},
		})
	})
	return database, task, id
}

func awaitSessionStoreBlock(ctx context.Context, database *Store, blocker, waiter uint32, finished <-chan struct{}) error {
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var blocked bool
		if err := database.Pool.QueryRow(ctx, `SELECT $1::integer=ANY(pg_blocking_pids($2))`, blocker, waiter).Scan(&blocked); err != nil {
			return err
		}
		if blocked {
			return nil
		}
		select {
		case <-finished:
			return fmt.Errorf("backend %d completed without waiting on backend %d", waiter, blocker)
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func assertSessionArchiveAfterDeletion(t *testing.T, database *Store, task model.Task, id, digest, path string) {
	t.Helper()
	var deleted bool
	var version int64
	if err := database.Pool.QueryRow(t.Context(), `SELECT deleted_at IS NOT NULL,version FROM tasks WHERE id=$1`, task.ID).Scan(&deleted, &version); err != nil || !deleted || version != task.Version+1 {
		t.Fatalf("committed deletion: deleted=%v version=%d error=%v", deleted, version, err)
	}
	sessionDAOTransaction(t, database, func(scope store.SessionScope) error {
		status, object, err := scope.SessionDAO().SessionArchive(t.Context(), id)
		if err != nil || status.State != "ready" || status.SHA256 == nil || *status.SHA256 != digest || status.ByteLength == nil || *status.ByteLength != "7" || object != path {
			t.Fatalf("archive receipt after deletion: %+v %q %v", status, object, err)
		}
		return nil
	})
}

func TestSessionArchiveWaitsForDeletionAndReadsCommittedState(t *testing.T) {
	database, task, id := sessionArchiveLockFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	deletion, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer deletion.Rollback(context.Background())
	tasks := pgtask.NewWriter(deletion, task.ProjectID)
	if _, err := tasks.Task(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := tasks.DeleteTask(ctx, task.ID, false); err != nil {
		t.Fatal(err)
	}
	archive, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Rollback(context.Background())
	digest, path := strings.Repeat("a", 64), "archive/object"
	done := make(chan struct{})
	blocker, waiter := deletion.Conn().PgConn().PID(), archive.Conn().PgConn().PID()
	var readDeleted bool
	var archiveErr error
	go func() {
		defer close(done)
		dao := pgsession.New(archive)
		var current store.SessionTask
		current, readDeleted, archiveErr = dao.LockArchiveTask(ctx, task.ProjectID, task.ID)
		if archiveErr == nil && current.Status != string(model.TaskDone) {
			archiveErr = fmt.Errorf("archive read task status %q", current.Status)
		}
		if archiveErr == nil {
			archiveErr = dao.SetSessionArchiveReady(ctx, id, digest, 7, path)
		}
		if archiveErr == nil {
			archiveErr = archive.Commit(ctx)
		}
	}()
	waitErr := awaitSessionStoreBlock(ctx, database, blocker, waiter, done)
	commitErr := deletion.Commit(ctx)
	<-done
	if waitErr != nil || commitErr != nil || archiveErr != nil || !readDeleted {
		t.Fatalf("delete-first serialization: wait=%v commit=%v archive=%v deleted=%v", waitErr, commitErr, archiveErr, readDeleted)
	}
	assertSessionArchiveAfterDeletion(t, database, task, id, digest, path)
}

func TestSessionDeletionWaitsForArchiveAndRetainsReceipt(t *testing.T) {
	database, task, id := sessionArchiveLockFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	archive, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Rollback(context.Background())
	dao := pgsession.New(archive)
	if _, deleted, err := dao.LockArchiveTask(ctx, task.ProjectID, task.ID); err != nil || deleted {
		t.Fatalf("initial archive task: deleted=%v error=%v", deleted, err)
	}
	digest, path := strings.Repeat("b", 64), "archive/object"
	if err := dao.SetSessionArchiveReady(ctx, id, digest, 7, path); err != nil {
		t.Fatal(err)
	}
	deletion, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer deletion.Rollback(context.Background())
	done := make(chan struct{})
	blocker, waiter := archive.Conn().PgConn().PID(), deletion.Conn().PgConn().PID()
	var deleteErr error
	go func() {
		defer close(done)
		tasks := pgtask.NewWriter(deletion, task.ProjectID)
		_, deleteErr = tasks.Task(ctx, task.ID)
		if deleteErr == nil {
			_, deleteErr = tasks.DeleteTask(ctx, task.ID, false)
		}
		if deleteErr == nil {
			deleteErr = deletion.Commit(ctx)
		}
	}()
	waitErr := awaitSessionStoreBlock(ctx, database, blocker, waiter, done)
	commitErr := archive.Commit(ctx)
	<-done
	if waitErr != nil || commitErr != nil || deleteErr != nil {
		t.Fatalf("archive-first serialization: wait=%v commit=%v delete=%v", waitErr, commitErr, deleteErr)
	}
	assertSessionArchiveAfterDeletion(t, database, task, id, digest, path)
}
