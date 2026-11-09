package session_test

import (
	"bytes"
	"context"
	"io"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

type archiveLeaseSpy struct {
	t      *testing.T
	mu     sync.Mutex
	calls  int
	closed chan struct{}
}

func newArchiveLeaseSpy(t *testing.T) *archiveLeaseSpy {
	return &archiveLeaseSpy{t: t, closed: make(chan struct{})}
}
func (s *archiveLeaseSpy) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.calls != 1 {
		s.t.Error("archive capability closed more than once")
		return nil
	}
	close(s.closed)
	return nil
}
func (s *archiveLeaseSpy) Closed() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.calls != 0 }
func (s *archiveLeaseSpy) AssertHeld(t *testing.T) {
	t.Helper()
	if s == nil || s.Closed() {
		t.Fatal("archive response released its capability before transport completion")
	}
}
func (s *archiveLeaseSpy) AssertClosed(t *testing.T) {
	t.Helper()
	if s == nil {
		t.Fatal("archive capability was never obtained")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.calls != 1 {
		t.Fatalf("archive capability close calls=%d, want1", s.calls)
	}
}

type archiveUploadStub struct {
	*archiveLeaseSpy
	fixture  *archiveHTTPFixture
	mu       sync.Mutex
	putCalls int
	terminal bool
}

func (op *archiveUploadStub) put(ctx context.Context, data []byte, terminal bool) (sp.ArchiveStatus, v2.Message, error) {
	op.mu.Lock()
	op.putCalls++
	count := op.putCalls
	op.mu.Unlock()
	if count != 1 {
		op.t.Error("archive upload capability received an extra body")
	}
	if terminal != op.terminal {
		op.t.Error("archive upload used the wrong protocol capability")
	}
	f := op.fixture
	f.mu.Lock()
	f.rawBodies = append(f.rawBodies, bytes.Clone(data))
	hook := f.BeforePut
	native, statusError, term := f.UploadResult, f.UploadError, f.TerminalUploadResult
	f.mu.Unlock()
	if hook != nil {
		if err := hook(ctx, data); err != nil {
			return sp.ArchiveStatus{}, v2.Message{}, err
		}
	}
	if terminal {
		return sp.ArchiveStatus{}, term, statusError
	}
	return native, v2.Message{}, statusError
}
func (op *archiveUploadStub) PutArchive(ctx context.Context, data []byte) (sp.ArchiveStatus, error) {
	status, _, err := op.put(ctx, data, false)
	return status, err
}
func (op *archiveUploadStub) PutTerminalArchive(ctx context.Context, data []byte) (v2.Message, error) {
	_, result, err := op.put(ctx, data, true)
	return result, err
}

type archiveHTTPFixture struct {
	t                    *testing.T
	handler              *resourceTestHandler
	backend              *routeBackend
	auth                 *routeAuthentication
	application          sessionApplication
	task                 api.Task
	base                 string
	registration         sp.Registration
	snapshot             sp.Snapshot
	mu                   sync.Mutex
	reservation          *archiveLeaseSpy
	operation            *archiveLeaseSpy
	reservations         []*archiveLeaseSpy
	operations           []*archiveLeaseSpy
	rawBodies            [][]byte
	Status               sp.ArchiveStatus
	StatusError          error
	UpdateResult         sp.ArchiveStatus
	UpdateError          error
	UploadResult         sp.ArchiveStatus
	TerminalUploadResult v2.Message
	UploadError          error
	ExpectedMode         sessioncore.ArchiveMode
	BeginError           error
	NativeContent        []byte
	TerminalContent      []byte
	ContentError         error
	BeforePut            func(context.Context, []byte) error
	BeforeRead           func(context.Context) error
	Updates              []sp.ArchiveUpdate
}

func archiveHTTPSetup(t *testing.T) *archiveHTTPFixture {
	t.Helper()
	f := &archiveHTTPFixture{t: t, backend: newRouteBackend(t), auth: newRouteAuthentication(t, "https://daynight.example"), Status: sp.ArchiveStatus{State: "unavailable"}, UpdateResult: sp.ArchiveStatus{State: "pending"}, UploadResult: sp.ArchiveStatus{State: "ready"}, ExpectedMode: sessioncore.ArchiveV1Upload}
	principal := model.Principal{UserID: uuid.NewString(), CredentialID: uuid.NewString(), Kind: model.PATCredential}
	f.task = api.Task{ID: uuid.NewString(), ProjectID: uuid.NewString(), Version: 1, Status: "in_progress"}
	f.registration = sp.Registration{Protocol: sp.Protocol, RegistrationID: uuid.NewString(), ClaimID: uuid.NewString(), WorkerID: uuid.NewString(), WorktreeID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex"}
	f.snapshot = sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), ClaimID: f.registration.ClaimID, ExecutionGeneration: "1"}, ConnectionEpoch: "0"}, Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, Identity: sp.Identity{ProjectID: f.task.ProjectID, TaskID: f.task.ID, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex"}, SessionRevision: "1", HistoryEpoch: uuid.NewString(), LastEventSeq: "0", LastTimelineSeq: "0", InitialInputState: "not_submitted", Lifecycle: "active", ConnectionState: "disconnected", Activity: "initializing"}
	f.base = taskPath(f.task) + "/sessions"
	f.configure(principal)
	f.handler = newResourceTestHandler(t, f.backend, f.auth, principal, io.Discard)
	f.application = f.handler.application
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := f.application.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	t.Cleanup(func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		for _, spy := range f.reservations {
			spy.AssertClosed(t)
		}
		for _, spy := range f.operations {
			spy.AssertClosed(t)
		}
	})
	return f
}
func (f *archiveHTTPFixture) configure(principal model.Principal) {
	check := func(actual model.Principal, project, task, id string) {
		f.t.Helper()
		if actual != principal || project != f.task.ProjectID || task != f.task.ID || id != f.snapshot.SessionID {
			f.t.Error("archive usecase changed principal or resource address")
		}
	}
	f.backend.Funcs.TryReserveArchivePreflight = func() (io.Closer, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.reservation != nil && !f.reservation.Closed() || f.operation != nil && !f.operation.Closed() {
			return nil, &model.Fault{Code: "resource_busy", Message: "Archive admission is busy."}
		}
		token := newArchiveLeaseSpy(f.t)
		f.reservation = token
		f.reservations = append(f.reservations, token)
		return token, nil
	}
	f.backend.Funcs.BeginArchiveReserved = func(ctx context.Context, p model.Principal, project, task, id string, mode sessioncore.ArchiveMode, token io.Closer) (sessionhttp.ArchiveOperationForTest, error) {
		check(p, project, task, id)
		f.mu.Lock()
		defer f.mu.Unlock()
		if token != f.reservation || mode != f.ExpectedMode {
			f.t.Error("archive upload lost its reservation or protocol mode")
		}
		if f.BeginError != nil {
			return nil, f.BeginError
		}
		lease := newArchiveLeaseSpy(f.t)
		f.operation = lease
		f.operations = append(f.operations, lease)
		return &archiveUploadStub{archiveLeaseSpy: lease, fixture: f, terminal: mode == sessioncore.ArchiveV2Upload}, nil
	}
	read := func(ctx context.Context, p model.Principal, project, task, id string, token io.Closer, terminal bool) (sessionhttp.ArchiveContentForTest, error) {
		check(p, project, task, id)
		f.mu.Lock()
		if token != f.reservation {
			f.t.Error("archive read replaced the preflight reservation")
		}
		hook := f.BeforeRead
		givenError := f.ContentError
		data := f.NativeContent
		if terminal {
			data = f.TerminalContent
		}
		f.mu.Unlock()
		if hook != nil {
			if err := hook(ctx); err != nil {
				return sessionhttp.ArchiveContentForTest{}, err
			}
		}
		if givenError != nil {
			return sessionhttp.ArchiveContentForTest{}, givenError
		}
		lease := newArchiveLeaseSpy(f.t)
		f.mu.Lock()
		f.operation = lease
		f.operations = append(f.operations, lease)
		f.mu.Unlock()
		return sessionhttp.ArchiveContentForTest{Data: bytes.Clone(data), Closer: lease}, nil
	}
	f.backend.Funcs.ArchiveContentReserved = func(ctx context.Context, p model.Principal, project, task, id string, token io.Closer) (sessionhttp.ArchiveContentForTest, error) {
		return read(ctx, p, project, task, id, token, false)
	}
	f.backend.Funcs.TerminalArchiveContentReserved = func(ctx context.Context, p model.Principal, project, task, id string, token io.Closer) (sessionhttp.ArchiveContentForTest, error) {
		return read(ctx, p, project, task, id, token, true)
	}
	f.backend.Funcs.ArchiveStatus = func(ctx context.Context, p model.Principal, project, task, id string) (sp.ArchiveStatus, error) {
		check(p, project, task, id)
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.Status, f.StatusError
	}
	f.backend.Funcs.UpdateArchive = func(ctx context.Context, p model.Principal, project, task, id string, input sp.ArchiveUpdate) (sp.ArchiveStatus, error) {
		check(p, project, task, id)
		f.mu.Lock()
		defer f.mu.Unlock()
		f.Updates = append(f.Updates, input)
		return f.UpdateResult, f.UpdateError
	}
	f.backend.Funcs.Current = func(ctx context.Context, p model.Principal, project, task string) (map[string]any, error) {
		check(p, project, task, f.snapshot.SessionID)
		return nil, &model.Fault{Code: "not_found", Message: "Session was not found."}
	}
	for _, name := range []string{"TryReserveArchivePreflight", "BeginArchiveReserved", "ArchiveContentReserved", "TerminalArchiveContentReserved", "ArchiveStatus", "UpdateArchive", "Current"} {
		f.backend.ExpectCalls(name, 0)
	}
}
func (f *archiveHTTPFixture) Expect(calls map[string]int) {
	f.backend.mu.Lock()
	for name, want := range f.backend.expected {
		if f.backend.calls[name] != want {
			f.t.Errorf("archive phase replaced before %s completed: got%d want%d", name, f.backend.calls[name], want)
		}
	}
	f.backend.mu.Unlock()
	for name, count := range calls {
		f.backend.ExpectCalls(name, f.backend.Called(name)+count)
	}
}
func (f *archiveHTTPFixture) Request(method, path, body string, calls map[string]int) *httptest.ResponseRecorder {
	f.Expect(calls)
	f.auth.ExpectCalls(1)
	return projectRequest(f.handler, method, path, body)
}
func (f *archiveHTTPFixture) SetUploadResult(status sp.ArchiveStatus, cause error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.UploadResult = status
	f.UploadError = cause
}
func (f *archiveHTTPFixture) SetNativeContent(data []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.NativeContent = bytes.Clone(data)
}
func (f *archiveHTTPFixture) SetTerminalContent(data []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.TerminalContent = bytes.Clone(data)
}
func (f *archiveHTTPFixture) AssertBody(t *testing.T, expected []byte) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.rawBodies) == 0 || !bytes.Equal(f.rawBodies[len(f.rawBodies)-1], expected) {
		t.Fatal("archive upload changed the actual consumed body")
	}
}
func (f *archiveHTTPFixture) AssertHeld(t *testing.T) {
	t.Helper()
	f.mu.Lock()
	reservation, operation := f.reservation, f.operation
	f.mu.Unlock()
	reservation.AssertHeld(t)
	operation.AssertHeld(t)
}
func (f *archiveHTTPFixture) AssertReleased(t *testing.T) {
	t.Helper()
	f.mu.Lock()
	reservation, operation := f.reservation, f.operation
	f.mu.Unlock()
	reservation.AssertClosed(t)
	if operation != nil {
		operation.AssertClosed(t)
	}
}
