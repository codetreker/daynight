package attachment

import (
	"context"
	"errors"
	"io"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

type taskPresenceSnapshot struct {
	store.SnapshotReader
	presenceErr, snapshotErr error
	taskReads, presenceReads int
}

func (s *taskPresenceSnapshot) ReadSnapshot(ctx context.Context, fn func(store.SnapshotScope) error) error {
	if s.snapshotErr != nil {
		return s.snapshotErr
	}
	return s.SnapshotReader.ReadSnapshot(ctx, func(scope store.SnapshotScope) error { return fn(taskPresenceScope{SnapshotScope: scope, owner: s}) })
}

type taskPresenceScope struct {
	store.SnapshotScope
	owner *taskPresenceSnapshot
}

func (s taskPresenceScope) TaskDAO() store.TaskReader {
	return taskPresenceReader{TaskReader: s.SnapshotScope.TaskDAO(), owner: s.owner}
}

type taskPresenceReader struct {
	store.TaskReader
	owner *taskPresenceSnapshot
}

func (r taskPresenceReader) Task(context.Context, string, string) (model.Task, error) {
	r.owner.taskReads++
	return model.Task{}, errors.New("full task read is forbidden")
}
func (r taskPresenceReader) TaskPresence(ctx context.Context, project, task string) (store.TaskPresence, error) {
	r.owner.presenceReads++
	if r.owner.presenceErr != nil {
		return store.TaskPresence{}, r.owner.presenceErr
	}
	return r.TaskReader.TaskPresence(ctx, project, task)
}
func TestAttachmentReadsUseBoundedTaskPresence(t *testing.T) {
	service, _, database, _, task, principal := attachmentService(t)
	putAttachment(t, service, principal, task, "file", "content")
	// Large persisted fields make the distinction observable without constructing
	// any full task in the attachment read path.
	if _, err := database.Pool.Exec(t.Context(), `UPDATE tasks SET description=repeat('x', 8388608) WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(t.Context(), `INSERT INTO task_properties(task_id,name,value) VALUES($1,'large',to_json(repeat('y',4194304))::text)`, task.ID); err != nil {
		t.Fatal(err)
	}
	observed := &taskPresenceSnapshot{SnapshotReader: database}
	service.store = observed
	page, err := service.List(t.Context(), principal, task.ProjectID, task.ID, model.PageRequest{Limit: 10})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("list: %+v %v", page, err)
	}
	_, obj, err := service.Open(t.Context(), principal, task.ProjectID, task.ID, "file")
	if err != nil {
		t.Fatal(err)
	}
	content, err := io.ReadAll(obj.Body)
	_ = obj.Body.Close()
	if err != nil || string(content) != "content" {
		t.Fatalf("open: %q %v", content, err)
	}
	_, obj, err = service.OpenBounded(t.Context(), principal, task.ProjectID, task.ID, "file", 2048)
	if err != nil {
		t.Fatal(err)
	}
	_ = obj.Body.Close()
	if observed.taskReads != 0 || observed.presenceReads != 3 {
		t.Fatalf("full task reads=%d presence reads=%d", observed.taskReads, observed.presenceReads)
	}
}
func TestAttachmentPresenceErrorAndAuthorizationSemantics(t *testing.T) {
	service, _, database, _, task, principal := attachmentService(t)
	putAttachment(t, service, principal, task, "file", "content")
	observed := &taskPresenceSnapshot{SnapshotReader: database}
	service.store = observed
	for _, action := range []string{"list", "open"} {
		run := func(id string, actor model.Principal) error {
			if action == "list" {
				_, err := service.List(t.Context(), actor, task.ProjectID, id, model.PageRequest{Limit: 1})
				return err
			}
			_, obj, err := service.Open(t.Context(), actor, task.ProjectID, id, "file")
			if err == nil {
				_ = obj.Body.Close()
			}
			return err
		}
		err := run(uuid.NewString(), principal)
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "not_found" {
			t.Fatalf("%s missing: %v", action, err)
		}
		outsider := testsupport.ServicePrincipal(t, database)
		before := observed.presenceReads
		if err := run(task.ID, outsider); err == nil {
			t.Fatalf("%s unauthorized", action)
		}
		if observed.presenceReads != before {
			t.Fatalf("%s queried task before authorization", action)
		}
		failure := errors.New("presence query failed")
		observed.presenceErr = failure
		if err := run(task.ID, principal); !errors.Is(err, failure) {
			t.Fatalf("%s presence error: %v", action, err)
		}
		observed.presenceErr = nil
		failure = errors.New("snapshot failed")
		observed.snapshotErr = failure
		if err := run(task.ID, principal); !errors.Is(err, failure) {
			t.Fatalf("%s snapshot error: %v", action, err)
		}
		observed.snapshotErr = nil
	}
	if _, err := database.Pool.Exec(t.Context(), `UPDATE tasks SET deleted_at=now() WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	for _, run := range []func() error{
		func() error {
			_, err := service.List(t.Context(), principal, task.ProjectID, task.ID, model.PageRequest{Limit: 1})
			return err
		},
		func() error {
			_, _, err := service.Open(t.Context(), principal, task.ProjectID, task.ID, "file")
			return err
		},
	} {
		err := run()
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "task_deleted" || !errors.Is(err, model.ErrTaskDeleted) {
			t.Fatalf("deleted task: %v", err)
		}
	}
	if observed.taskReads != 0 {
		t.Fatalf("full task reads: %d", observed.taskReads)
	}
}
