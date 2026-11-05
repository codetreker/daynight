package sessionrelay

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func endArchiveTask(t *testing.T, f fixture, state string) model.Task {
	t.Helper()
	ctx := context.Background()
	tasks := service.NewTasks(f.s.DB)
	var ended model.Task
	var err error
	if state == "released" {
		ended, err = tasks.ReleaseWorker(ctx, f.p, f.project, f.task, service.ReleaseWorker{Version: 1, ClaimID: f.r.ClaimID, StoppedConfirmed: true})
	} else {
		ended, err = tasks.SetStatus(ctx, f.p, f.project, f.task, service.SetTaskStatus{Version: 1, Status: model.TaskDone, ClaimID: &f.r.ClaimID})
	}
	if err != nil {
		t.Fatal(err)
	}
	return ended
}

func deleteArchiveTask(t *testing.T, f fixture, version int64) {
	t.Helper()
	if err := service.NewTasks(f.s.DB).Delete(context.Background(), f.p, f.project, f.task, service.DeleteTask{Version: version}); err != nil {
		t.Fatal(err)
	}
}

func TestDeletedTaskArchiveCanFinishWithoutReopeningSession(t *testing.T) {
	for _, state := range []string{"completed", "released"} {
		for _, stage := range []string{"unavailable", "pending", "ready"} {
			t.Run(state+"/"+stage, func(t *testing.T) {
				f, v, data := archiveFixture(t)
				ctx := context.Background()
				ended := endArchiveTask(t, f, state)
				update := sp.ArchiveUpdate{Fence: v.Fence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, State: "pending"}
				if stage != "unavailable" {
					if _, err := f.s.UpdateArchive(ctx, f.p, f.project, f.task, v.SessionID, update); err != nil {
						t.Fatal(err)
					}
				}
				if stage == "ready" {
					if _, err := f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, data); err != nil {
						t.Fatal(err)
					}
				}
				deleteArchiveTask(t, f, ended.Version)
				status, err := f.s.ArchiveStatus(ctx, f.p, f.project, f.task, v.SessionID)
				if err != nil || status.State != stage {
					t.Fatalf("deleted task archive status: %#v %v", status, err)
				}
				if status, err = f.s.UpdateArchive(ctx, f.p, f.project, f.task, v.SessionID, update); err != nil || (status.State != "pending" && status.State != "ready") {
					t.Fatal(status, err)
				}
				for range 2 {
					if status, err = f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, data); err != nil || status.State != "ready" {
						t.Fatal("deleted task upload or identical retry", status, err)
					}
				}
				if _, err = f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, append(data, ' ')); err == nil {
					t.Fatal("deleted task replaced immutable archive")
				}
				if got, err := f.s.ArchiveStatus(ctx, f.p, f.project, f.task, v.SessionID); err != nil || got.State != "ready" || got.SHA256 == nil || status.SHA256 == nil || *got.SHA256 != *status.SHA256 {
					t.Fatal("lost upload reply cannot be reconciled", got, err)
				}
				if _, err = f.s.ArchiveContent(ctx, f.p, f.project, f.task, v.SessionID); err == nil {
					t.Fatal("deleted task archive content reopened")
				}
				if _, err = f.s.Current(ctx, f.p, f.project, f.task); err == nil {
					t.Fatal("deleted task session reopened")
				}
				if _, err = f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, sp.Command{Fence: v.Fence, Kind: "refresh_controls", OperationID: uuid.NewString()}); err == nil {
					t.Fatal("deleted task allowed control")
				}
				_, err = service.NewTasks(f.s.DB).Get(ctx, f.p, f.project, f.task)
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "task_deleted" {
					t.Fatal("ordinary deleted task became visible", err)
				}
			})
		}
	}
}

func TestDeletedTaskArchiveRequiresCurrentOwnerCredentialAndMembership(t *testing.T) {
	for _, kind := range []string{"browser", "other member", "removed member", "revoked", "expired"} {
		t.Run(kind, func(t *testing.T) {
			f, v, data := archiveFixture(t)
			ctx := context.Background()
			ended := endArchiveTask(t, f, "completed")
			deleteArchiveTask(t, f, ended.Version)
			principal := f.p
			var err error
			switch kind {
			case "browser":
				principal = listCredential(t, f, f.p.UserID, model.SessionCredential)
			case "other member":
				principal = listCredential(t, f, uuid.NewString(), model.PATCredential)
				_, err = f.s.DB.Pool.Exec(ctx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, f.project, principal.UserID)
			case "removed member":
				_, err = f.s.DB.Pool.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, f.project, principal.UserID)
			case "revoked":
				_, err = f.s.DB.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, principal.CredentialID)
			case "expired":
				_, err = f.s.DB.Pool.Exec(ctx, `UPDATE personal_access_tokens SET created_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' WHERE id=$1`, principal.CredentialID)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err = f.s.ArchiveStatus(ctx, principal, f.project, f.task, v.SessionID); err == nil {
				t.Fatal("unauthorized archive status")
			}
			update := sp.ArchiveUpdate{Fence: v.Fence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, State: "pending"}
			if _, err = f.s.UpdateArchive(ctx, principal, f.project, f.task, v.SessionID, update); err == nil {
				t.Fatal("unauthorized archive update")
			}
			if _, err = f.s.PutArchive(ctx, principal, f.project, f.task, v.SessionID, data); err == nil {
				t.Fatal("unauthorized archive upload")
			}
		})
	}
}

func TestDeletedTaskArchiveRetainsScopeFenceAndNativeIdentity(t *testing.T) {
	f, v, data := archiveFixture(t)
	ctx := context.Background()
	ended := endArchiveTask(t, f, "released")
	deleteArchiveTask(t, f, ended.Version)
	if _, err := f.s.DB.Pool.Exec(ctx, `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,'{identity,nativeSessionId}','"original-native"') WHERE id=$1`, v.SessionID); err != nil {
		t.Fatal(err)
	}
	doc, err := sp.DecodeArchive(data)
	if err != nil {
		t.Fatal(err)
	}
	native := "original-native"
	doc.NativeSessionID = &native
	for name, mutate := range map[string]func(*sp.ArchiveDocument){
		"generation": func(d *sp.ArchiveDocument) { d.ExecutionGeneration = "2" },
		"claim":      func(d *sp.ArchiveDocument) { d.ClaimID = uuid.NewString() },
		"controller": func(d *sp.ArchiveDocument) { d.ControllerID = uuid.NewString() },
		"instance":   func(d *sp.ArchiveDocument) { d.ControllerInstanceID = uuid.NewString() },
		"session":    func(d *sp.ArchiveDocument) { d.SessionID = uuid.NewString() },
		"provider":   func(d *sp.ArchiveDocument) { d.Provider = "claude" },
		"native":     func(d *sp.ArchiveDocument) { value := "foreign-native"; d.NativeSessionID = &value },
	} {
		t.Run(name, func(t *testing.T) {
			bad := doc
			mutate(&bad)
			if _, err := f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, encode(bad)); err == nil {
				t.Fatal("mismatched execution accepted")
			}
			if name != "provider" && name != "native" {
				update := sp.ArchiveUpdate{Fence: bad.Fence, ControllerID: bad.ControllerID, ControllerInstanceID: bad.ControllerInstanceID, State: "pending"}
				if _, err := f.s.UpdateArchive(ctx, f.p, f.project, f.task, v.SessionID, update); err == nil {
					t.Fatal("mismatched state update accepted")
				}
			}
		})
	}
	for _, scope := range [][3]string{{uuid.NewString(), f.task, v.SessionID}, {f.project, uuid.NewString(), v.SessionID}, {f.project, f.task, uuid.NewString()}, {"", "", v.SessionID}} {
		if _, err := f.s.ArchiveStatus(ctx, f.p, scope[0], scope[1], scope[2]); err == nil {
			t.Fatal("mismatched task or session accepted", scope)
		}
	}
	storage := &failingArchiveStorage{Storage: f.s.files, fail: true}
	f.s.files = storage
	if _, err := f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, encode(doc)); err == nil {
		t.Fatal("storage failure ignored")
	}
	storage.fail = false
	if status, err := f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, encode(doc)); err != nil || status.State != "ready" {
		t.Fatal("deleted task retry failed", status, err)
	}
}

func waitArchiveLock(ctx context.Context, f fixture, prefix string) error {
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		if err := f.s.DB.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1)`, prefix+"%").Scan(&waiting); err != nil {
			return err
		}
		if waiting {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func TestArchiveWaitsForDeletionCommitThenFinalizes(t *testing.T) {
	f, v, data := archiveFixture(t)
	endArchiveTask(t, f, "completed")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	deleted := make(chan struct{})
	release := make(chan struct{})
	deletion := make(chan error, 1)
	go func() {
		deletion <- f.s.DB.WriteProject(ctx, f.project, func(tx *store.ProjectTx) error {
			if _, err := tx.Task(ctx, f.task); err != nil {
				return err
			}
			if err := tx.DeleteTask(ctx, f.task, false); err != nil {
				return err
			}
			close(deleted)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
	}()
	select {
	case <-deleted:
	case err := <-deletion:
		t.Fatal("deletion did not reach transaction barrier", err)
	}
	upload := make(chan error, 1)
	go func() { _, err := f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, data); upload <- err }()
	waitErr := waitArchiveLock(ctx, f, "SELECT status,deleted_at IS NOT NULL FROM tasks WHERE")
	close(release)
	deleteErr, uploadErr := <-deletion, <-upload
	if waitErr != nil || deleteErr != nil || uploadErr != nil {
		t.Fatal("delete-first serialization", waitErr, deleteErr, uploadErr)
	}
	if status, err := f.s.ArchiveStatus(ctx, f.p, f.project, f.task, v.SessionID); err != nil || status.State != "ready" {
		t.Fatal(status, err)
	}
}

type blockingArchiveStorage struct {
	filestorage.Storage
	entered chan struct{}
	release chan struct{}
}

func (s *blockingArchiveStorage) Put(ctx context.Context, bucket, path string, reader io.Reader) (filestorage.FileInfo, error) {
	close(s.entered)
	select {
	case <-s.release:
		return s.Storage.Put(ctx, bucket, path, reader)
	case <-ctx.Done():
		return filestorage.FileInfo{}, ctx.Err()
	}
}

func TestDeletionWaitsForArchiveCommitAndPreservesReceipt(t *testing.T) {
	f, v, data := archiveFixture(t)
	ended := endArchiveTask(t, f, "released")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	files := &blockingArchiveStorage{Storage: f.s.files, entered: make(chan struct{}), release: make(chan struct{})}
	f.s.files = files
	upload := make(chan error, 1)
	go func() { _, err := f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, data); upload <- err }()
	select {
	case <-files.entered:
	case err := <-upload:
		t.Fatal("upload did not reach storage barrier", err)
	}
	deletion := make(chan error, 1)
	go func() {
		deletion <- service.NewTasks(f.s.DB).Delete(ctx, f.p, f.project, f.task, service.DeleteTask{Version: ended.Version})
	}()
	waitErr := waitArchiveLock(ctx, f, "SELECT t.id::text")
	close(files.release)
	uploadErr, deleteErr := <-upload, <-deletion
	if waitErr != nil || deleteErr != nil || uploadErr != nil {
		t.Fatal("archive-first serialization", waitErr, deleteErr, uploadErr)
	}
	if status, err := f.s.ArchiveStatus(ctx, f.p, f.project, f.task, v.SessionID); err != nil || status.State != "ready" {
		t.Fatal("lost upload reply cannot be reconciled after deletion", status, err)
	}
}
