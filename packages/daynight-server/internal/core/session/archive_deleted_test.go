package session

import (
	"context"
	"io"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func endArchiveTask(t *testing.T, f fixture, state string) {
	t.Helper()
	worker := *f.data.Task.Worker
	worker.State = model.WorkerState(state)
	f.data.Task.Worker = &worker
	f.data.Session.Snapshot.Lifecycle = "draining"
	if state == "completed" {
		f.data.Task.Status = "done"
	}
}

func deleteArchiveTask(f fixture) {
	f.data.TaskDeleted = true
	f.data.ArchiveMetadata.TaskDeleted = true
}

func TestDeletedTaskArchiveCanFinishWithoutReopeningSession(t *testing.T) {
	for _, state := range []string{"completed", "released"} {
		for _, stage := range []string{"unavailable", "pending", "ready"} {
			t.Run(state+"/"+stage, func(t *testing.T) {
				f, v, data := archiveFixture(t)
				f.dao.Expect("SetSessionArchiveReady", 1)
				stateWrites := 1
				if stage == "pending" {
					stateWrites = 2
				}
				f.dao.Expect("SetSessionArchiveState", stateWrites)
				ctx := context.Background()
				endArchiveTask(t, f, state)
				update := sp.ArchiveUpdate{Fence: v.Fence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, State: "pending"}
				if stage != "unavailable" {
					if _, err := fixtureArchiveUpdate(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, update, map[string]int{"SetSessionArchiveState": 1}); err != nil {
						t.Fatal(err)
					}
					acceptArchiveState(t, f, "pending")
				}
				if stage == "ready" {
					if _, err := fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, data, map[string]int{"SetSessionArchiveReady": 1}); err != nil {
						t.Fatal(err)
					}
					acceptArchiveWrites(t, f, v.SessionID, data)
				}
				deleteArchiveTask(f)
				status, err := fixtureArchiveStatus(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, nil)
				if err != nil || status.State != stage {
					t.Fatalf("deleted task archive status: %#v %v", status, err)
				}
				stateWork := map[string]int{}
				if stage != "ready" {
					stateWork["SetSessionArchiveState"] = 1
				}
				if status, err = fixtureArchiveUpdate(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, update, stateWork); err != nil || (status.State != "pending" && status.State != "ready") {
					t.Fatal(status, err)
				}
				if stage != "ready" {
					acceptArchiveState(t, f, "pending")
				}
				for i := range 2 {
					readyWork := map[string]int{}
					if stage != "ready" && i == 0 {
						readyWork["SetSessionArchiveReady"] = 1
					}
					if status, err = fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, data, readyWork); err != nil || status.State != "ready" {
						t.Fatal("deleted task upload or identical retry", status, err)
					}
					if stage != "ready" && i == 0 {
						acceptArchiveWrites(t, f, v.SessionID, data)
					}
				}
				if _, err = fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, append(data, ' '), nil); err == nil {
					t.Fatal("deleted task replaced immutable archive")
				}
				if got, err := fixtureArchiveStatus(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, nil); err != nil || got.State != "ready" || got.SHA256 == nil || status.SHA256 == nil || *got.SHA256 != *status.SHA256 {
					t.Fatal("lost upload reply cannot be reconciled", got, err)
				}
				if _, err = fixtureArchiveContent(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, archivePreflightOnly(1, 1, 1)); err == nil {
					t.Fatal("deleted task archive content reopened")
				}
				phase := f.dao.ContextPhase(ctx, map[string]int{"LockTask": 1})
				_, err = f.s.Current(phase, f.p, f.project, f.task)
				f.dao.FinishContext(phase)
				if err == nil {
					t.Fatal("deleted task session reopened")
				}
				phase = f.dao.ContextPhase(ctx, map[string]int{"LockTask": 1})
				_, err = f.s.Submit(phase, f.p, f.project, f.task, v.SessionID, sp.Command{Fence: v.Fence, Kind: "refresh_controls", OperationID: uuid.NewString()})
				f.dao.FinishContext(phase)
				if err == nil {
					t.Fatal("deleted task allowed control")
				}
			})
		}
	}
}

func TestDeletedTaskArchiveRequiresCurrentOwnerCredentialAndMembership(t *testing.T) {
	for _, kind := range []string{"browser", "other member", "removed member", "revoked", "expired"} {
		t.Run(kind, func(t *testing.T) {
			f, v, data := archiveFixture(t)
			f.dao.Expect("SetSessionArchiveReady", 0)
			f.dao.Expect("SetSessionArchiveState", 0)
			ctx := context.Background()
			endArchiveTask(t, f, "completed")
			deleteArchiveTask(f)
			principal := f.p
			var err error
			switch kind {
			case "browser":
				principal = listCredential(t, f, f.p.UserID, model.SessionCredential)
			case "other member":
				principal = listCredential(t, f, uuid.NewString(), model.PATCredential)
				allowFixtureProject(t, f, principal, "admin")
			case "removed member":
				f.dao.ProjectAccessFn = func(context.Context, string, string) (model.ProjectAccess, error) {
					return model.ProjectAccess{}, model.ErrNotFound
				}
			case "revoked":
				f.dao.ReadCredentialFn = func(context.Context, model.Principal, time.Time) error { return model.ErrNotFound }
				f.dao.LockCredentialFn = func(context.Context, model.Principal, time.Time) error { return model.ErrNotFound }
			case "expired":
				f.dao.ReadCredentialFn = func(context.Context, model.Principal, time.Time) error { return model.ErrNotFound }
				f.dao.LockCredentialFn = func(context.Context, model.Principal, time.Time) error { return model.ErrNotFound }
			}
			refusalWork := map[string]int{"SessionArchive": 0}
			preflightWork := archivePreflightOnly(1, 1, 1)
			switch kind {
			case "removed member":
				refusalWork["SessionBotID"], refusalWork["LockSession"] = 0, 0
				preflightWork = archivePreflightOnly(1, 1, 0)
			case "revoked", "expired":
				refusalWork["ProjectAccess"], refusalWork["SessionBotID"], refusalWork["LockSession"] = 0, 0, 0
				preflightWork = archivePreflightOnly(1, 0, 0)
			}
			if _, err = fixtureArchiveStatus(f, f.s, ctx, principal, f.project, f.task, v.SessionID, refusalWork); err == nil {
				t.Fatal("unauthorized archive status")
			}
			update := sp.ArchiveUpdate{Fence: v.Fence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, State: "pending"}
			if _, err = fixtureArchiveUpdate(f, f.s, ctx, principal, f.project, f.task, v.SessionID, update, refusalWork); err == nil {
				t.Fatal("unauthorized archive update")
			}
			if _, err = fixtureArchivePut(f, f.s, ctx, principal, f.project, f.task, v.SessionID, data, preflightWork); err == nil {
				t.Fatal("unauthorized archive upload")
			}
		})
	}
}

func TestDeletedTaskArchiveRetainsScopeFenceAndNativeIdentity(t *testing.T) {
	f, v, data := archiveFixture(t)
	f.dao.Expect("SetSessionArchiveReady", 1)
	f.dao.Expect("SetSessionArchiveState", 0)
	ctx := context.Background()
	endArchiveTask(t, f, "released")
	deleteArchiveTask(f)
	native := "original-native"
	f.data.Session.Snapshot.Identity.NativeSessionID = &native
	doc, err := sp.DecodeArchive(data)
	if err != nil {
		t.Fatal(err)
	}
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
			if _, err := fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, encode(bad), map[string]int{"SessionArchive": 0}); err == nil {
				t.Fatal("mismatched execution accepted")
			}
			if name != "provider" && name != "native" {
				update := sp.ArchiveUpdate{Fence: bad.Fence, ControllerID: bad.ControllerID, ControllerInstanceID: bad.ControllerInstanceID, State: "pending"}
				if _, err := fixtureArchiveUpdate(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, update, map[string]int{"SessionArchive": 0}); err == nil {
					t.Fatal("mismatched state update accepted")
				}
			}
		})
	}
	for index, scope := range [][3]string{{uuid.NewString(), f.task, v.SessionID}, {f.project, uuid.NewString(), v.SessionID}, {f.project, f.task, uuid.NewString()}, {"", "", v.SessionID}} {
		scopeWork := archiveTaskRefusal()
		if index == 2 {
			scopeWork = map[string]int{"LockSession": 0, "SessionArchive": 0}
			f.dao.SessionBotIDFn = func(context.Context, string) (*string, error) { return nil, model.ErrNotFound }
		}
		if index == 3 {
			scopeWork = map[string]int{"LockArchiveTask": 0, "LockCredential": 0, "ProjectAccess": 0, "SessionArchive": 0}
			f.dao.SessionBotIDFn = func(context.Context, string) (*string, error) { return nil, nil }
		}
		if _, err := fixtureArchiveStatus(f, f.s, ctx, f.p, scope[0], scope[1], scope[2], scopeWork); err == nil {
			t.Fatal("mismatched task or session accepted", scope)
		}
	}
	f.dao.SessionBotIDFn = func(context.Context, string) (*string, error) { return nil, nil }
	storage := &failingArchiveStorage{Storage: f.s.files, fail: true}
	f.s.files = storage
	if _, err := fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, encode(doc), nil); err == nil {
		t.Fatal("storage failure ignored")
	}
	storage.fail = false
	if status, err := fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, encode(doc), map[string]int{"SetSessionArchiveReady": 1}); err != nil || status.State != "ready" {
		t.Fatal("deleted task retry failed", status, err)
	}
	acceptArchiveWrites(t, f, v.SessionID, encode(doc))
}

func TestArchiveWaitsForDeletionCommitThenFinalizes(t *testing.T) {
	f, v, data := archiveFixture(t)
	f.dao.Expect("SetSessionArchiveReady", 1)
	f.dao.Expect("SetSessionArchiveState", 0)
	endArchiveTask(t, f, "completed")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	entered, release := make(chan struct{}), make(chan struct{})
	called := false
	f.dao.LockArchiveTaskFn = func(ctx context.Context, project, id string) (store.SessionTask, bool, error) {
		if project != f.project || id != f.task {
			t.Error("archive acquired another task", project, id)
			return store.SessionTask{}, false, model.ErrNotFound
		}
		if !called {
			called = true
			close(entered)
			select {
			case <-release:
			case <-ctx.Done():
				return store.SessionTask{}, false, ctx.Err()
			}
		}
		return f.data.Task, f.data.TaskDeleted, nil
	}
	upload := make(chan error, 1)
	go func() {
		_, err := fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, data, map[string]int{"SetSessionArchiveReady": 1})
		upload <- err
	}()
	select {
	case <-entered:
	case err := <-upload:
		t.Fatal("archive did not reach task barrier", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if f.dao.Called("SetSessionArchiveReady") != 0 {
		t.Error("archive wrote a receipt before task admission")
	}
	f.data.TaskDeleted = true
	f.data.ArchiveMetadata.TaskDeleted = true
	close(release)
	if err := <-upload; err != nil {
		t.Fatal("finalize after deletion facts", err)
	}
	acceptArchiveWrites(t, f, v.SessionID, data)
	if status, err := fixtureArchiveStatus(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, nil); err != nil || status.State != "ready" {
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

func TestArchiveReceiptIsCapturedOnlyAfterStorageCompletes(t *testing.T) {
	f, v, data := archiveFixture(t)
	f.dao.Expect("SetSessionArchiveReady", 1)
	f.dao.Expect("SetSessionArchiveState", 0)
	endArchiveTask(t, f, "released")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	files := &blockingArchiveStorage{Storage: f.s.files, entered: make(chan struct{}), release: make(chan struct{})}
	f.s.files = files
	upload := make(chan error, 1)
	go func() {
		_, err := fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, data, map[string]int{"SetSessionArchiveReady": 1})
		upload <- err
	}()
	select {
	case <-files.entered:
	case err := <-upload:
		t.Fatal("upload did not reach storage barrier", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if f.dao.Called("SetSessionArchiveReady") != 0 {
		t.Error("archive receipt preceded storage completion")
	}
	close(files.release)
	if err := <-upload; err != nil {
		t.Fatal(err)
	}
	if f.dao.Called("SetSessionArchiveReady") != 1 {
		t.Fatal("archive did not propose exactly one ready receipt")
	}
	acceptArchiveWrites(t, f, v.SessionID, data)
	deleteArchiveTask(f)
	if status, err := fixtureArchiveStatus(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, nil); err != nil || status.State != "ready" {
		t.Fatal("captured upload reply cannot be reconciled after deleted task facts", status, err)
	}
}
