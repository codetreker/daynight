package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestStoreAttachmentMutationCommitsAndRollsBackCallback(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := t.Context()
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 2, model.TaskTodo)
	value := model.Attachment{ProjectID: project.ID, TaskID: task.ID, Path: "transaction.txt", ContentType: "text/plain", SizeBytes: 7}
	calls := 0
	completion, err := database.WriteAttachmentMutation(ctx, func(scope store.AttachmentMutationScope) error {
		calls++
		presence, err := scope.LockTaskPresence(ctx, project.ID, task.ID)
		if err != nil {
			return err
		}
		if !presence.Found || presence.DeletedAt != nil {
			t.Fatalf("presence=%#v", presence)
		}
		actual, created, err := scope.AttachmentDAO().PutAttachment(ctx, value)
		if err != nil {
			return err
		}
		if !created || actual.Path != value.Path || actual.SizeBytes != 7 {
			t.Fatalf("mutation insert=%#v, created=%v", actual, created)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted || calls != 1 {
		t.Fatalf("completion=%#v, calls=%d, error=%v", completion, calls, err)
	}
	cause := errors.New("file stream refused")
	completion, err = database.WriteAttachmentMutation(ctx, func(scope store.AttachmentMutationScope) error {
		calls++
		if err := scope.AttachmentDAO().DeleteAttachment(ctx, project.ID, task.ID, value.Path); err != nil {
			return err
		}
		return cause
	})
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, cause) || calls != 2 {
		t.Fatalf("rollback completion=%#v, calls=%d, error=%v", completion, calls, err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		actual, err := snapshot.AttachmentDAO().Attachment(ctx, project.ID, task.ID, value.Path)
		if err != nil {
			return err
		}
		if actual.Path != value.Path || actual.SizeBytes != 7 {
			t.Fatalf("rolled back attachment=%#v", actual)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	completion, err = database.WriteAttachmentMutation(canceled, func(store.AttachmentMutationScope) error { calls++; return nil })
	var failure *store.Error
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, context.Canceled) || calls != 2 || !errors.As(err, &failure) || failure.Phase != "begin attachment mutation" {
		t.Fatalf("begin completion=%#v, calls=%d, error=%v", completion, calls, err)
	}
}

func TestStoreTaskSearchEntryPointRetainsSnapshotAndCallbackCause(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := t.Context()
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 2, model.TaskTodo)
	mustQueryExec(t, database, `UPDATE tasks SET type='goal' WHERE id=$1`, task.ID)
	calls := 0
	if err := database.ReadTaskSearch(ctx, func(snapshot store.TaskSearchSnapshot) error {
		calls++
		first, err := snapshot.Fence(ctx, project.ID)
		if err != nil {
			return err
		}
		titles, err := snapshot.Titles(ctx, project.ID, []string{task.ID})
		if err != nil {
			return err
		}
		if titles[task.ID] != task.Title {
			t.Fatalf("initial title=%#v", titles)
		}
		mustQueryExec(t, database, `UPDATE tasks SET title='Changed',version=version+1 WHERE id=$1`, task.ID)
		second, err := snapshot.Fence(ctx, project.ID)
		if err != nil {
			return err
		}
		if first != second {
			t.Fatalf("snapshot fence changed: %#v -> %#v", first, second)
		}
		titles, err = snapshot.Titles(ctx, project.ID, []string{task.ID})
		if err != nil {
			return err
		}
		if titles[task.ID] != task.Title {
			t.Fatalf("snapshot title changed=%#v", titles)
		}
		return nil
	}); err != nil || calls != 1 {
		t.Fatalf("search callback calls=%d, error=%v", calls, err)
	}
	if err := database.ReadTaskSearch(ctx, func(snapshot store.TaskSearchSnapshot) error {
		titles, err := snapshot.Titles(ctx, project.ID, []string{task.ID})
		if err != nil {
			return err
		}
		if titles[task.ID] != "Changed" {
			t.Fatalf("new snapshot missed change=%#v", titles)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	cause := errors.New("caller rejected search result")
	if err := database.ReadTaskSearch(ctx, func(store.TaskSearchSnapshot) error { return cause }); !errors.Is(err, cause) {
		t.Fatalf("callback cause=%v", err)
	}
}
