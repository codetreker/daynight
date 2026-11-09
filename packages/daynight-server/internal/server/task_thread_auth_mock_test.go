package server

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type taskCredentialFixture struct {
	t                   *testing.T
	database            *httpTestStore
	server              *httptest.Server
	client              *http.Client
	requestMu           sync.Mutex
	requestFinished     chan struct{}
	origin              string
	project             model.Project
	task                model.Task
	logs                bytes.Buffer
	actor               model.Principal
	plan                *httpCallPlan
	authenticationError error
}

type taskCredentialDAO struct {
	httpRejectedIdentityDAO
	fixture *taskCredentialFixture
}

func (d *taskCredentialDAO) Authenticate(ctx context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
	f := d.fixture
	f.plan.Called("authenticate")
	if kind != f.actor.Kind || !bytes.Equal(hash, secret.Hash(httpTestToken(kind))) || now.IsZero() || now.Location() != time.UTC || ctx.Err() != nil {
		f.fail("authentication changed credential kind/hash/time/context: %s %v", kind, now)
	}
	return f.actor, f.authenticationError
}

func newTaskCredentialFixture(t *testing.T) *taskCredentialFixture {
	t.Helper()
	project, task, _ := taskHTTPMockModels()
	f := &taskCredentialFixture{t: t, database: newHTTPTestStore(t), project: project, task: task}
	f.server = httptest.NewUnstartedServer(nil)
	t.Cleanup(f.server.Close)
	config := configuredTestConfig()
	f.origin = "https://" + f.server.Listener.Addr().String()
	config.PublicOrigin = f.origin
	config.UniAuthCallbackURL = f.origin + "/api/v1/auth/callback"
	config.AllowHTTPTestOrigin, config.AllowLoopbackHTTP = true, true
	logger := slog.New(slog.NewJSONHandler(&f.logs, nil))
	handler, err := newTestHandler(Dependencies{Store: f.database, Files: attachmentTestFiles(t)}, config, logger)
	if err != nil {
		t.Fatal(err)
	}
	logged := httpx.RequestLogging(logger, handler)
	f.server.Config.Handler = http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		f.requestMu.Lock()
		finished := f.requestFinished
		f.requestMu.Unlock()
		if finished == nil {
			unexpectedHTTPCall(t, "HTTP request without an active fixture plan")
		}
		defer close(finished)
		logged.ServeHTTP(response, request)
	})
	f.server.StartTLS()
	f.client = f.server.Client()
	f.client.Timeout = 5 * time.Second
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := handler.(*sessionApplication).Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	f.database.WriteIdentityCall = func(ctx context.Context, run func(store.IdentityScope) error) (store.Completion, error) {
		f.plan.Called("identity")
		err := run(httpAuthenticationScope{t: t, dao: &taskCredentialDAO{httpRejectedIdentityDAO: httpRejectedIdentityDAO{t: t}, fixture: f}})
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	return f
}

func (f *taskCredentialFixture) request(actor model.Principal, method, path string, body any, headers map[string]string, status int, code string, calls map[string]int) *httptest.ResponseRecorder {
	f.t.Helper()
	f.requestMu.Lock()
	f.actor = actor
	f.plan = newHTTPCallPlan(f.t, calls)
	finished := make(chan struct{})
	f.requestFinished = finished
	f.requestMu.Unlock()
	text := ""
	if body != nil {
		text = jsonBody(f.t, body)
	}
	request, err := http.NewRequest(method, f.origin+path, strings.NewReader(text))
	if err != nil {
		f.fail("construct HTTP request: %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "project-test")
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	wire, err := f.client.Do(request)
	if err != nil {
		f.fail("send HTTP request: %v", err)
	}
	response := httptest.NewRecorder()
	for name, values := range wire.Header {
		response.Header()[name] = copyTaskHTTPSlice(values)
	}
	response.WriteHeader(wire.StatusCode)
	_, readErr := io.Copy(response, wire.Body)
	closeErr := wire.Body.Close()
	if readErr != nil || closeErr != nil {
		f.fail("read or close HTTP response: %v / %v", readErr, closeErr)
	}
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		f.fail("HTTP handler did not finish")
	}
	f.requestMu.Lock()
	f.requestFinished = nil
	f.requestMu.Unlock()
	f.plan.Verify()
	if response.Code != status || response.Header().Get("Cache-Control") != "no-store" {
		f.fail("authenticated response %s %s: %d %s %v", method, path, response.Code, response.Body, response.Header())
	}
	if code != "" {
		assertProjectError(f.t, response, status, code)
	}
	return response
}

func taskCredentialCalls(methods ...string) map[string]int {
	calls := map[string]int{"identity": 1, "authenticate": 1}
	for _, method := range methods {
		calls[method]++
	}
	return calls
}

func (f *taskCredentialFixture) expectRead(current model.Task, items []model.ThreadMessage, accessError error) {
	current = copyTaskHTTPTask(current)
	items = copyThreadAuthenticationMessages(items)
	base := newTaskHTTPMockBase(f.t, "Thread HTTP read")
	project := &taskHTTPProjectReaderMock{taskHTTPMockBase: base}
	project.ProjectAccessFn = func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
		f.plan.Called("access")
		if actor != f.actor || id != f.project.ID || ctx.Err() != nil {
			f.fail("read authorization changed actor or Project")
		}
		access := taskHTTPMockAccess(f.project, actor)
		access.Role = model.ProjectMemberRole
		return access, accessError
	}
	credentials := &taskHTTPCredentialReaderMock{taskHTTPMockBase: base}
	credentials.CredentialFn = func(ctx context.Context, actor model.Principal) (store.ThreadCredential, error) {
		f.plan.Called("credential")
		if actor != f.actor || ctx.Err() != nil {
			f.fail("Thread read changed credential identity")
		}
		return store.ThreadCredential{}, nil
	}
	reader := &taskHTTPReaderMock{taskHTTPMockBase: base}
	reader.TaskPresenceFn = func(ctx context.Context, project, task string) (store.TaskPresence, error) {
		f.plan.Called("presence")
		f.requireAddress(ctx, project, task)
		return store.TaskPresence{Found: true}, nil
	}
	reader.TaskFn = func(ctx context.Context, project, task string) (model.Task, error) {
		f.plan.Called("task")
		f.requireAddress(ctx, project, task)
		return copyTaskHTTPTask(current), nil
	}
	reader.TaskCacheEpochFn = func(ctx context.Context, project string) (string, error) {
		f.plan.Called("epoch")
		if project != f.project.ID || ctx.Err() != nil {
			f.fail("Task cache Project identity changed")
		}
		return "7", nil
	}
	reader.ThreadCandidatesFn = func(ctx context.Context, task string, anchor *model.ThreadPosition, before bool, count int) ([]model.ThreadMessage, error) {
		f.plan.Called("candidates")
		if task != f.task.ID || anchor != nil || !before || count != 51 || ctx.Err() != nil {
			f.fail("Thread page selection changed")
		}
		return copyThreadAuthenticationMessages(items), nil
	}
	reader.ThreadSidesFn = func(ctx context.Context, task string, first, last model.ThreadPosition) (bool, bool, error) {
		f.plan.Called("sides")
		if task != f.task.ID || len(items) != 2 || first != items[1].Position() || last != items[0].Position() || ctx.Err() != nil {
			f.fail("Thread page sides changed anchors")
		}
		return false, false, nil
	}
	snapshot := newHTTPTestSnapshot(f.t)
	snapshot.Credentials, snapshot.Projects, snapshot.Tasks = credentials, project, reader
	f.database.ReadSnapshotCall = func(ctx context.Context, run func(store.SnapshotScope) error) error {
		f.plan.Called("snapshot")
		return run(snapshot)
	}
	f.database.WriteThreadCall = nil
}

func (f *taskCredentialFixture) requireAddress(ctx context.Context, project, task string) {
	f.t.Helper()
	if project != f.project.ID || task != f.task.ID || ctx.Err() != nil {
		f.fail("Thread DAO address/context changed")
	}
}

func (f *taskCredentialFixture) expectPost(current model.Task, message model.ThreadMessage, accessError error) {
	current = copyTaskHTTPTask(current)
	message = copyThreadAuthenticationMessage(message)
	base := newTaskHTTPMockBase(f.t, "Thread HTTP post")
	tasks := &taskHTTPThreadTaskMock{taskHTTPMockBase: base}
	tasks.LockTaskPresenceFn = func(ctx context.Context, project, task string) (store.TaskPresence, error) {
		f.plan.Called("presence")
		f.requireAddress(ctx, project, task)
		return store.TaskPresence{Found: true}, nil
	}
	tasks.SourceTaskFn = func(ctx context.Context, project, task string) (model.Task, error) {
		f.plan.Called("source")
		f.requireAddress(ctx, project, task)
		return copyTaskHTTPTask(current), nil
	}
	credentials := &taskHTTPThreadCredentialMock{taskHTTPMockBase: base}
	credentials.CredentialFn = func(ctx context.Context, actor model.Principal) (store.ThreadCredential, error) {
		f.plan.Called("credential")
		if actor != f.actor || ctx.Err() != nil {
			f.fail("Thread post changed credential identity")
		}
		return store.ThreadCredential{}, nil
	}
	credentials.AuthorNameFn = func(ctx context.Context, user string) (*string, error) {
		f.plan.Called("author")
		if user != f.actor.UserID || ctx.Err() != nil {
			f.fail("Thread author lookup changed identity")
		}
		name := "Member"
		return &name, nil
	}
	credentials.CredentialValidFn = func(ctx context.Context, credential store.ThreadCredential) (bool, error) {
		f.plan.Called("valid")
		if credential.ExpiresAt != nil || ctx.Err() != nil {
			f.fail("Thread final admission changed locked credential")
		}
		return true, nil
	}
	projects := &taskHTTPThreadProjectMock{taskHTTPMockBase: base}
	projects.LockProjectAuthorizationFn = func(ctx context.Context, actor model.Principal, project string) (model.ProjectAccess, error) {
		f.plan.Called("access")
		if actor != f.actor || project != f.project.ID || ctx.Err() != nil {
			f.fail("Thread write authorization changed actor/Project")
		}
		access := taskHTTPMockAccess(f.project, actor)
		access.Role = model.ProjectMemberRole
		return access, accessError
	}
	dao := &taskHTTPThreadDAOMock{taskHTTPMockBase: base}
	dao.LockHeadFn = func(ctx context.Context, task string) (*model.ThreadPosition, error) {
		f.plan.Called("head")
		if task != f.task.ID || ctx.Err() != nil {
			f.fail("Thread head lock changed Task")
		}
		return nil, nil
	}
	dao.InsertMessageFn = func(ctx context.Context, candidate model.ThreadMessage) (model.ThreadMessage, error) {
		f.plan.Called("insert")
		expected := copyThreadAuthenticationMessage(message)
		expected.ID, expected.CreatedAt = "", time.Time{}
		if !reflect.DeepEqual(candidate, expected) || ctx.Err() != nil {
			f.fail("candidate=%#v want=%#v", candidate, expected)
		}
		return copyThreadAuthenticationMessage(message), nil
	}
	dao.PrepareTimestampFn = func(ctx context.Context, candidate *model.ThreadMessage, head *model.ThreadPosition) error {
		f.plan.Called("timestamp")
		if !reflect.DeepEqual(*candidate, message) || head != nil || ctx.Err() != nil {
			f.fail("timestamp changed inserted message or head")
		}
		return nil
	}
	dao.AdvanceHeadFn = func(ctx context.Context, task string, position model.ThreadPosition) error {
		f.plan.Called("advance")
		if task != f.task.ID || position != message.Position() || ctx.Err() != nil {
			f.fail("Thread head advanced to a different message")
		}
		return nil
	}
	capture := &taskHTTPCaptureDAOMock{taskHTTPMockBase: base}
	capture.FreezeAudienceFn = func(ctx context.Context, project string, types []string) ([]store.WebhookAudience, error) {
		f.plan.Called("capture")
		if project != f.project.ID || !reflect.DeepEqual(types, []string{protocol.ThreadPosted}) || ctx.Err() != nil {
			f.fail("Thread notification source changed")
		}
		return []store.WebhookAudience{}, nil
	}
	scope := &taskHTTPThreadScopeMock{taskHTTPMockBase: base, TaskDAOFn: func() store.ThreadTaskDAO { return tasks }, CredentialDAOFn: func() store.ThreadCredentialDAO { return credentials }, ProjectDAOFn: func() store.ThreadProjectDAO { return projects }, ThreadDAOFn: func() store.ThreadDAO { return dao }, CaptureDAOFn: func() store.WebhookCaptureDAO { return capture }}
	f.database.WriteThreadCall = func(ctx context.Context, run func(store.ThreadScope) error) (store.Completion, error) {
		f.plan.Called("write")
		err := run(scope)
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	f.database.ReadSnapshotCall = nil
}

func taskCredentialDecode[T any](t *testing.T, response *httptest.ResponseRecorder) T {
	return identityDecode[T](t, response.Body.Bytes())
}

func copyThreadAuthenticationMessage(message model.ThreadMessage) model.ThreadMessage {
	message.Author.DisplayName = copyTaskHTTPPointer(message.Author.DisplayName)
	message.Author.Execution = copyTaskHTTPPointer(message.Author.Execution)
	message.ReplyTo = copyTaskHTTPPointer(message.ReplyTo)
	return message
}

func copyThreadAuthenticationMessages(messages []model.ThreadMessage) []model.ThreadMessage {
	result := copyTaskHTTPSlice(messages)
	for index := range result {
		result[index] = copyThreadAuthenticationMessage(result[index])
	}
	return result
}

func (f *taskCredentialFixture) fail(format string, values ...any) {
	f.t.Helper()
	f.t.Errorf(format, values...)
	panic(fmt.Sprintf(format, values...))
}
