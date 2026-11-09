package session_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type archiveRouteInput struct {
	Task        store.SessionTask
	TaskDeleted bool
	TaskError   error
	Session     store.SessionRecord
	Metadata    store.ArchiveMetadata
	Archive     sp.ArchiveStatus
	ArchivePath string
}

type archiveRouteReady struct {
	SessionID, Digest, Path string
	Length                  int
}
type archiveRouteWrites struct {
	Ready   *archiveRouteReady
	State   *sp.ArchiveStatus
	Session *store.SessionRecord
}
type archiveHTTPFixture struct {
	handler      *resourceTestHandler
	backend      *routeBackend
	auth         *routeAuthentication
	application  sessionApplication
	files        filestorage.Storage
	task         api.Task
	base         string
	registration sp.Registration
	snapshot     sp.Snapshot
	mu           sync.Mutex
	input        archiveRouteInput
	writes       archiveRouteWrites
}

func archiveHTTPSetup(t *testing.T) *archiveHTTPFixture {
	t.Helper()
	return archiveHTTPSetupWithFiles(t, attachmentTestFiles(t))
}

func archiveHTTPSetupWithFiles(t *testing.T, files filestorage.Storage) *archiveHTTPFixture {
	t.Helper()
	f := &archiveHTTPFixture{backend: newRouteBackend(t), auth: newRouteAuthentication(t, "https://daynight.example"), files: files}
	principal := model.Principal{UserID: uuid.NewString(), CredentialID: uuid.NewString(), Kind: model.PATCredential}
	f.handler = &resourceTestHandler{principal: principal}
	f.task = api.Task{ID: uuid.NewString(), ProjectID: uuid.NewString(), Version: 1, Status: "in_progress"}
	f.registration = sp.Registration{Protocol: sp.Protocol, RegistrationID: uuid.NewString(), ClaimID: uuid.NewString(), WorkerID: uuid.NewString(), WorktreeID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex"}
	f.snapshot = sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), ClaimID: f.registration.ClaimID, ExecutionGeneration: "1"}, ConnectionEpoch: "0"}, Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, Identity: sp.Identity{ProjectID: f.task.ProjectID, TaskID: f.task.ID, WorkerID: f.registration.WorkerID, WorktreeID: f.registration.WorktreeID, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex", AgentControlMode: "web"}, SessionRevision: "1", HistoryEpoch: uuid.NewString(), LastEventSeq: "0", LastTimelineSeq: "0", InitialInputState: "not_submitted", Lifecycle: "active", ConnectionState: "disconnected", Activity: "initializing"}
	f.base = taskPath(f.task) + "/sessions"
	f.input = archiveRouteInput{Task: store.SessionTask{Status: "in_progress", Worker: &model.WorkerClaim{ClaimID: f.registration.ClaimID, UserID: principal.UserID, WorkerID: f.registration.WorkerID, WorktreeID: f.registration.WorktreeID, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, State: model.WorkerActive}}, Session: store.SessionRecord{Snapshot: f.snapshot, Owner: principal.UserID, Parent: principal.CredentialID, Registration: []byte(jsonBody(t, f.registration))}, Metadata: store.ArchiveMetadata{Owner: principal.UserID, Parent: principal.CredentialID, Project: f.task.ProjectID, Task: f.task.ID, Backend: "web", TaskExists: true, ProjectLive: true, BotValid: true}, Archive: sp.ArchiveStatus{State: "unavailable"}}
	f.configure(t)
	f.handler = newResourceTestHandler(t, f.backend, f.auth, principal, files, io.Discard)
	f.application = f.handler.application
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := f.application.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	return f
}

func (f *archiveHTTPFixture) configure(t *testing.T) {
	t.Helper()
	principal := f.handler.principal
	checkCredential := func(ctx context.Context, actual model.Principal, now time.Time) error {
		if actual != principal || now.IsZero() {
			t.Fatal("archive credential arguments changed")
		}
		return ctx.Err()
	}
	f.backend.DAO.ReadCredentialFn = checkCredential
	f.backend.DAO.LockCredentialFn = checkCredential
	f.backend.DAO.ProjectAccessFn = func(ctx context.Context, user, project string) (model.ProjectAccess, error) {
		in := routeInputFor[archiveRouteInput](ctx)
		if user != principal.UserID || project != in.Session.Snapshot.Identity.ProjectID {
			t.Fatal("archive access changed its user or Project")
		}
		return model.ProjectAccess{UserID: user, ProjectID: project, Role: model.ProjectAdmin}, nil
	}
	f.backend.DAO.ArchiveMetadataFn = func(ctx context.Context, id string) (store.ArchiveMetadata, error) {
		in := routeInputFor[archiveRouteInput](ctx)
		if id != in.Session.Snapshot.SessionID {
			t.Fatal("archive metadata changed Session identity")
		}
		return in.Metadata, nil
	}
	f.backend.DAO.LockTaskFn = func(ctx context.Context, project, id string) (store.SessionTask, error) {
		in := routeInputFor[archiveRouteInput](ctx)
		if project != f.task.ProjectID || id != f.task.ID {
			t.Fatal("archive task lock changed scope")
		}
		return in.Task, in.TaskError
	}
	f.backend.DAO.LockArchiveTaskFn = func(ctx context.Context, project, id string) (store.SessionTask, bool, error) {
		in := routeInputFor[archiveRouteInput](ctx)
		if project != f.task.ProjectID || id != f.task.ID {
			t.Fatal("archive finalization lock changed scope")
		}
		return in.Task, in.TaskDeleted, nil
	}
	f.backend.DAO.SessionBotIDFn = func(ctx context.Context, id string) (*string, error) {
		in := routeInputFor[archiveRouteInput](ctx)
		if id != in.Session.Snapshot.SessionID {
			t.Fatal("archive Bot lookup changed Session identity")
		}
		return nil, nil
	}
	f.backend.DAO.LockSessionFn = func(ctx context.Context, id string) (store.SessionRecord, error) {
		in := routeInputFor[archiveRouteInput](ctx)
		if id != in.Session.Snapshot.SessionID {
			t.Fatal("archive lock changed Session identity")
		}
		return in.Session, nil
	}
	f.backend.DAO.SessionArchiveFn = func(ctx context.Context, id string) (sp.ArchiveStatus, string, error) {
		in := routeInputFor[archiveRouteInput](ctx)
		if id != in.Session.Snapshot.SessionID {
			t.Fatal("archive lookup changed Session identity")
		}
		return in.Archive, in.ArchivePath, nil
	}
	f.backend.DAO.SetSessionArchiveStateFn = func(ctx context.Context, id, state string, code *string) error {
		in := routeInputFor[archiveRouteInput](ctx)
		if id != in.Session.Snapshot.SessionID {
			t.Fatal("archive status write changed Session identity")
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		f.writes.State = &sp.ArchiveStatus{State: state, ErrorCode: code}
		return nil
	}
	f.backend.DAO.SetSessionArchiveReadyFn = func(ctx context.Context, id, digest string, size int, path string) error {
		in := routeInputFor[archiveRouteInput](ctx)
		if id != in.Session.Snapshot.SessionID {
			t.Fatal("archive ready write changed Session identity")
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		f.writes.Ready = &archiveRouteReady{SessionID: id, Digest: digest, Length: size, Path: path}
		return nil
	}
	f.backend.DAO.SaveSessionFn = func(ctx context.Context, value store.SessionRecord) error {
		in := routeInputFor[archiveRouteInput](ctx)
		if value.Snapshot.SessionID != in.Session.Snapshot.SessionID {
			t.Fatal("archive Session write changed identity")
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		copy := routeCopy(value)
		f.writes.Session = &copy
		return nil
	}
}

func (f *archiveHTTPFixture) InputSnapshot() archiveRouteInput {
	f.mu.Lock()
	defer f.mu.Unlock()
	in := f.input
	in.Task = routeCopy(in.Task)
	in.Session = routeCopy(in.Session)
	in.Archive = routeCopy(in.Archive)
	return in
}
func (f *archiveHTTPFixture) SetInput(input archiveRouteInput) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.input = input
}
func (f *archiveHTTPFixture) Declare(name string, calls map[string]int, repeat bool) {
	f.backend.Declare(name, calls, func() any { return f.InputSnapshot() }, repeat)
}
func (f *archiveHTTPFixture) UseEndedTaskInput() {
	in := f.InputSnapshot()
	in.Task.Status = "done"
	in.Task.Worker.State = model.WorkerCompleted
	f.SetInput(in)
}
func (f *archiveHTTPFixture) UseDeletedTaskInput() {
	in := f.InputSnapshot()
	in.TaskDeleted = true
	in.TaskError = model.ErrNotFound
	in.Metadata.TaskDeleted = true
	f.SetInput(in)
}
func (f *archiveHTTPFixture) Request(method, path, body string, names ...string) *httptest.ResponseRecorder {
	return projectRequest(f.handler, method, path, body, names...)
}
func (f *archiveHTTPFixture) AcceptState(t *testing.T, state string) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.writes.State == nil || f.writes.State.State != state {
		t.Fatal("archive status phase did not propose the requested state")
	}
	f.input.Archive = routeCopy(*f.writes.State)
	f.writes.State = nil
}
func (f *archiveHTTPFixture) AcceptReady(t *testing.T, data []byte) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	ready := f.writes.Ready
	hash := sha256.Sum256(data)
	digest := hex.EncodeToString(hash[:])
	namespace, err := sessionarchive.NewNamespace(sessionarchive.Projects, f.task.ProjectID, f.snapshot.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	path, err := namespace.ObjectPath(digest)
	if err != nil {
		t.Fatal(err)
	}
	if ready == nil || ready.SessionID != f.snapshot.SessionID || ready.Digest != digest || ready.Length != len(data) || ready.Path != path {
		t.Fatal("archive ready proposal changed bytes or physical ownership")
	}
	size := strconv.Itoa(len(data))
	f.input.Archive = sp.ArchiveStatus{State: "ready", SHA256: &digest, ByteLength: &size}
	f.input.ArchivePath = path
	f.writes.Ready = nil
}
func archivePreflightCounts() map[string]int {
	return map[string]int{"ReadCredential": 1, "ArchiveMetadata": 1, "ProjectAccess": 1}
}
func archiveScopeCounts(finalize bool, work map[string]int) map[string]int {
	lock := "LockTask"
	if finalize {
		lock = "LockArchiveTask"
	}
	return mergeArchiveCounts(map[string]int{lock: 1, "LockCredential": 1, "ProjectAccess": 1, "SessionBotID": 1, "LockSession": 1}, work)
}
func mergeArchiveCounts(base, work map[string]int) map[string]int {
	out := map[string]int{}
	for key, value := range base {
		out[key] = value
	}
	for key, value := range work {
		out[key] = value
	}
	return out
}
