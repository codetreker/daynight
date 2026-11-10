package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type taskCredentialContextKey struct{}

type taskCredentialFixture struct {
	t                   *testing.T
	tasks               *taskHTTPOperations
	threads             *taskHTTPThreadOperations
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

func newTaskCredentialFixture(t *testing.T) *taskCredentialFixture {
	t.Helper()
	project, task, _ := taskHTTPMockModels()
	f := &taskCredentialFixture{t: t, tasks: &taskHTTPOperations{t: t}, threads: &taskHTTPThreadOperations{t: t}, project: project, task: task}
	f.server = httptest.NewUnstartedServer(nil)
	t.Cleanup(f.server.Close)
	config := configuredTestConfig()
	f.origin = "https://" + f.server.Listener.Addr().String()
	config.PublicOrigin = f.origin
	config.UniAuthCallbackURL = f.origin + "/api/v1/auth/callback"
	config.AllowHTTPTestOrigin, config.AllowLoopbackHTTP = true, true
	identity := &operationHTTPIdentity{t: t, CallbackURLFn: func() string { return config.UniAuthCallbackURL }}
	identity.AuthenticateFn = func(ctx context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
		f.plan.Called("authenticate")
		if kind != f.actor.Kind || token != httpTestToken(kind) {
			f.fail("authentication changed raw credential kind/token: %s", kind)
		}
		f.requireContext(ctx)
		return f.actor, f.authenticationError
	}
	handler := newOperationHTTPServerWithConfig(t, identity, func(deps *httpDependencies) {
		deps.Tasks, deps.TaskThreads = f.tasks, f.threads
	}, &f.logs, defaultHTTPPrincipal(), config)
	f.server.Config.Handler = http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		f.requestMu.Lock()
		finished := f.requestFinished
		f.requestMu.Unlock()
		if finished == nil {
			unexpectedHTTPCall(t, "HTTP request without an active fixture plan")
		}
		defer close(finished)
		request = request.WithContext(context.WithValue(request.Context(), taskCredentialContextKey{}, finished))
		handler.ServeHTTP(response, request)
	})
	f.server.StartTLS()
	f.client = f.server.Client()
	f.client.Timeout = 5 * time.Second
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
	calls := map[string]int{"authenticate": 1}
	for _, method := range methods {
		calls[method]++
	}
	return calls
}

func (f *taskCredentialFixture) requireContext(ctx context.Context) {
	f.t.Helper()
	requireOperationHTTPContext(f.t, ctx)
	if ctx.Err() != nil || ctx.Value(taskCredentialContextKey{}) != f.requestFinished {
		f.fail("business operation lost the active HTTP request context")
	}
}

func (f *taskCredentialFixture) requireOperation(ctx context.Context, actor model.Principal, project, task string) {
	f.t.Helper()
	f.requireContext(ctx)
	if actor != f.actor || project != f.project.ID || task != f.task.ID {
		f.fail("HTTP operation changed principal or Project/Task address")
	}
}

func (f *taskCredentialFixture) expectTaskRead(current model.Task, finalError error) {
	current = copyTaskHTTPTask(current)
	f.tasks.ObserveCall = func(ctx context.Context, actor model.Principal, project, task string) (taskservice.TaskObservation, error) {
		f.plan.Called("task-observe")
		f.requireOperation(ctx, actor, project, task)
		return taskservice.TaskObservation{Task: copyTaskHTTPTask(current), Epoch: "7"}, finalError
	}
}

func (f *taskCredentialFixture) expectThreadRead(input taskservice.ThreadListRequest, page model.ThreadPage, encoded api.ThreadPage, finalError error) {
	input.BeforeID, input.AfterID = copyTaskHTTPPointer(input.BeforeID), copyTaskHTTPPointer(input.AfterID)
	page.Items = copyThreadAuthenticationMessages(page.Items)
	data := taskCredentialJSON(f.t, encoded)
	f.threads.ListCall = func(ctx context.Context, actor model.Principal, project, task string, actual taskservice.ThreadListRequest) (taskservice.ThreadPageDocument, error) {
		f.plan.Called("thread-list")
		f.requireOperation(ctx, actor, project, task)
		if !reflect.DeepEqual(actual, input) {
			f.fail("Thread list input=%#v, want=%#v", actual, input)
		}
		out := page
		out.Items = copyThreadAuthenticationMessages(page.Items)
		return taskservice.ThreadPageDocument{Page: out, JSON: bytes.Clone(data)}, finalError
	}
}

func (f *taskCredentialFixture) expectPost(input taskservice.CreateThreadMessage, message model.ThreadMessage, encoded api.ThreadMessage, finalError error) {
	input.ReplyTo, input.ClaimID = copyTaskHTTPPointer(input.ReplyTo), copyTaskHTTPPointer(input.ClaimID)
	message = copyThreadAuthenticationMessage(message)
	data := taskCredentialJSON(f.t, encoded)
	f.threads.PostCall = func(ctx context.Context, actor model.Principal, project, task string, actual taskservice.CreateThreadMessage) (taskservice.ThreadMessageDocument, error) {
		f.plan.Called("thread-post")
		f.requireOperation(ctx, actor, project, task)
		if !reflect.DeepEqual(actual, input) {
			f.fail("Thread post input=%#v, want=%#v", actual, input)
		}
		return taskservice.ThreadMessageDocument{Message: copyThreadAuthenticationMessage(message), JSON: bytes.Clone(data)}, finalError
	}
}

func taskCredentialJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
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
