package task_test

import (
	"bytes"
	"context"
	"encoding/json"
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

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
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

// Identity callbacks supply authentication facts and transaction completion independently.
type taskHTTPIdentityWriter struct {
	t                 *testing.T
	WriteIdentityCall func(context.Context, func() error) (store.Completion, error)
	AuthenticateCall  func(context.Context, model.CredentialKind, []byte, time.Time) (model.Principal, error)
}

func (w *taskHTTPIdentityWriter) WriteIdentity(ctx context.Context, run func(store.IdentityScope) error) (store.Completion, error) {
	if w.WriteIdentityCall == nil || run == nil {
		unexpectedHTTPCall(w.t, "WriteIdentity")
	}
	return w.WriteIdentityCall(ctx, func() error { return run(taskHTTPIdentityScope{w: w}) })
}

type taskHTTPIdentityScope struct{ w *taskHTTPIdentityWriter }

func (s taskHTTPIdentityScope) IdentityDAO() store.IdentityDAO {
	return taskHTTPIdentityDAO{lifecycleRejectedIdentityDAO: lifecycleRejectedIdentityDAO{t: s.w.t}, w: s.w}
}
func (s taskHTTPIdentityScope) CredentialFamilyDAO() store.CredentialFamilyDAO {
	unexpectedHTTPCall(s.w.t, "CredentialFamilyDAO")
	panic("unreachable")
}
func (s taskHTTPIdentityScope) PersonalTeamDAO() store.PersonalTeamDAO {
	unexpectedHTTPCall(s.w.t, "PersonalTeamDAO")
	return nil
}

type taskHTTPIdentityDAO struct {
	lifecycleRejectedIdentityDAO
	w *taskHTTPIdentityWriter
}

func (d taskHTTPIdentityDAO) Authenticate(ctx context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
	if d.w.AuthenticateCall == nil {
		unexpectedHTTPCall(d.w.t, "IdentityDAO.Authenticate")
	}
	return d.w.AuthenticateCall(ctx, kind, hash, now)
}

func newTaskCredentialFixture(t *testing.T) *taskCredentialFixture {
	return newTaskCredentialFixtureMode(t, false)
}

func newTaskThreadCredentialFixture(t *testing.T) *taskCredentialFixture {
	return newTaskCredentialFixtureMode(t, true)
}

func newTaskCredentialFixtureMode(t *testing.T, thread bool) *taskCredentialFixture {
	t.Helper()
	project, task, _ := taskHTTPMockModels()
	f := &taskCredentialFixture{t: t, database: newHTTPTestStore(t), project: project, task: task}
	f.server = httptest.NewUnstartedServer(nil)
	t.Cleanup(f.server.Close)
	f.origin = "https://" + f.server.Listener.Addr().String()
	logger := slog.New(slog.NewJSONHandler(&f.logs, nil))
	writer := &taskHTTPIdentityWriter{t: t}
	writer.WriteIdentityCall = func(ctx context.Context, run func() error) (store.Completion, error) {
		f.plan.Called("identity")
		err := run()
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	writer.AuthenticateCall = func(ctx context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
		f.plan.Called("authenticate")
		if kind != f.actor.Kind || !bytes.Equal(hash, secret.Hash(httpTestToken(kind))) || now.IsZero() || now.Location() != time.UTC || ctx.Err() != nil {
			f.fail("authentication changed credential kind/hash/time/context: %s %v", kind, now)
		}
		return f.actor, f.authenticationError
	}
	identity := identityservice.New(writer, nil, f.origin+"/api/v1/auth/callback")
	auth, err := authhttp.NewRequestAuthentication(identity.Authenticate, authconfig.AuthSettings{PublicOrigin: f.origin}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	if thread {
		taskhttp.TaskThreadRoutes(mux, taskservice.NewTaskThreads(f.database), auth, logger)
	} else {
		engine := sessioncore.NewEngine(nil)
		taskhttp.TaskRoutes(mux, taskservice.NewTasks(f.database), taskservice.NewObservations(f.database, engine), auth, logger)
	}
	logged := httpx.RequestLogging(logger, mux)
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

func (f *taskCredentialFixture) expectRead(current model.Task, accessError error) {
	current = copyTaskHTTPTask(current)
	base := newTaskHTTPMockBase(f.t, "Lifecycle HTTP read")
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
	reader := &taskHTTPReaderMock{taskHTTPMockBase: base}
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
	snapshot := &taskHTTPSnapshotScopeMock{taskHTTPMockBase: base, ProjectDAOFn: func() store.ProjectReader { return project }, TaskDAOFn: func() store.TaskReader { return reader }}
	f.database.ReadSnapshotCall = func(ctx context.Context, run func(store.SnapshotScope) error) error {
		f.plan.Called("snapshot")
		return run(snapshot)
	}
}
func taskCredentialDecode[T any](t *testing.T, response *httptest.ResponseRecorder) T {
	return decodeResponse[T](t, response, response.Code)
}

func (f *taskCredentialFixture) requireAddress(ctx context.Context, project, task string) {
	f.t.Helper()
	if project != f.project.ID || task != f.task.ID || ctx.Err() != nil {
		f.fail("Thread DAO address/context changed")
	}
}

func (f *taskCredentialFixture) fail(format string, values ...any) {
	f.t.Helper()
	f.t.Errorf(format, values...)
	panic(fmt.Sprintf(format, values...))
}

type lifecycleRejectedIdentityDAO struct{ t *testing.T }

func (d lifecycleRejectedIdentityDAO) Authenticate(context.Context, model.CredentialKind, []byte, time.Time) (model.Principal, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.Authenticate")
	panic("unreachable")
}

func (d lifecycleRejectedIdentityDAO) CleanupCredentials(context.Context, time.Time) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.CleanupCredentials")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) CleanupLoginCredentials(context.Context, time.Time, time.Time) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.CleanupLoginCredentials")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) AdmitLogin(context.Context, []byte, int, int) (time.Time, string, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.AdmitLogin")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) InsertLogin(context.Context, model.LoginTransaction) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.InsertLogin")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) ConsumeLogin(context.Context, []byte, []byte, time.Time) (model.LoginTransaction, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.ConsumeLogin")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) UpsertUser(context.Context, model.User, time.Time) (model.User, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.UpsertUser")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) LockProfileCredential(context.Context, model.Principal, time.Time) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.LockProfileCredential")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) EnsureUser(context.Context, model.User, time.Time) (model.User, bool, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.EnsureUser")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) PatchUser(context.Context, string, model.UserProfilePatch) (model.User, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.PatchUser")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) InsertSession(context.Context, model.Session) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.InsertSession")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) IdentityUser(context.Context, string) (model.User, store.PersonalTeamFacts, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.IdentityUser")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) IdentityPersonalTeam(context.Context, string) (store.PersonalTeamFacts, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.IdentityPersonalTeam")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) DeleteSession(context.Context, model.Principal) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.DeleteSession")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) LockSession(context.Context, model.Principal, time.Time) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.LockSession")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) InsertPAT(context.Context, model.PersonalAccessToken) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.InsertPAT")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) ListPATs(context.Context, string, time.Time) ([]model.PersonalAccessToken, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.ListPATs")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) DeletePAT(context.Context, string, string) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.DeletePAT")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) LockActivePAT(context.Context, string, string, time.Time) (model.PersonalAccessToken, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.LockActivePAT")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) SetPATExpiry(context.Context, string, *time.Time) (model.PersonalAccessToken, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.SetPATExpiry")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) PruneDeviceRates(context.Context, time.Time) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.PruneDeviceRates")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) IncrementDeviceRate(context.Context, model.DeviceRateBucket, time.Time) (int, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.IncrementDeviceRate")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) PruneDevices(context.Context, time.Time) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.PruneDevices")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) InsertDevice(context.Context, model.DeviceAuthorization) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.InsertDevice")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) DeviceByUserCode(context.Context, string, string, bool) (model.DeviceAuthorization, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.DeviceByUserCode")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) LockDeviceByHash(context.Context, []byte) (model.DeviceAuthorization, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.LockDeviceByHash")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) SetDeviceDecision(context.Context, string, string, string) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.SetDeviceDecision")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) DelayDevicePoll(context.Context, string, time.Time, bool) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.DelayDevicePoll")
	panic("unreachable")
}
func (d lifecycleRejectedIdentityDAO) ConsumeDevice(context.Context, string) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.ConsumeDevice")
	panic("unreachable")
}

func lifecycleTaskValues(task model.Task) store.TaskWrite {
	return copyTaskHTTPWrite(store.TaskWrite{Type: task.Type, ParentID: task.ParentID, AssignedTo: task.AssignedTo, RequiredPlatform: task.RequiredPlatform, AllowAgents: task.AllowAgents, Title: task.Title, Description: task.Description, Properties: task.Properties, Status: task.Status, DependsOn: task.DependsOn, ExternalDependsOn: task.ExternalDependsOn})
}

func (f *taskCredentialFixture) expectLifecycleMutation(before, after model.Task, prerequisite model.Task, patch bool, accessError error, completion store.TransactionOutcome) {
	before, after, prerequisite = copyTaskHTTPTask(before), copyTaskHTTPTask(after), copyTaskHTTPTask(prerequisite)
	expectedValues := lifecycleTaskValues(after)
	base := newTaskHTTPMockBase(f.t, "Lifecycle HTTP write")
	project := &taskHTTPProjectWriterMock{taskHTTPMockBase: base}
	project.ProjectAccessFn = func(ctx context.Context, actor model.Principal) (model.ProjectAccess, error) {
		f.plan.Called("access")
		if actor != f.actor || ctx.Err() != nil {
			f.fail("lifecycle write changed actor/context")
		}
		access := taskHTTPMockAccess(f.project, actor)
		access.Role = model.ProjectMemberRole
		return access, accessError
	}
	writer := &taskHTTPWriterMock{taskHTTPMockBase: base}
	writer.TaskFn = func(ctx context.Context, id string) (model.Task, error) {
		f.plan.Called("task")
		f.requireAddress(ctx, f.project.ID, id)
		return copyTaskHTTPTask(before), nil
	}
	writer.TasksByIDFn = func(ctx context.Context, ids []string) ([]model.Task, error) {
		f.plan.Called("dependencies")
		if !patch || !reflect.DeepEqual(ids, []string{prerequisite.ID}) || ctx.Err() != nil {
			f.fail("lifecycle PATCH changed prerequisite selection")
		}
		return []model.Task{copyTaskHTTPTask(prerequisite)}, nil
	}
	writer.ReachableFn = func(ctx context.Context, dependency, target string, replacement store.DependencyReplacement) (bool, error) {
		f.plan.Called("reachable")
		if !patch || dependency != prerequisite.ID || target != before.ID || !reflect.DeepEqual(replacement, store.DependencyReplacement{TaskID: before.ID, DependsOn: []string{prerequisite.ID}}) || ctx.Err() != nil {
			f.fail("lifecycle dependency check changed scope")
		}
		return false, nil
	}
	writer.UpdateTaskFn = func(ctx context.Context, id string, values store.TaskWrite) (model.Task, error) {
		f.plan.Called("update")
		f.requireAddress(ctx, f.project.ID, id)
		if !reflect.DeepEqual(values, expectedValues) {
			f.fail("lifecycle candidate=%#v, want=%#v", values, expectedValues)
		}
		return copyTaskHTTPTask(after), nil
	}
	sessions := &taskHTTPProjectSessionMock{taskHTTPMockBase: base}
	sessions.DrainTaskSessionsFn = func(ctx context.Context, id string, drain store.TaskSessionDrain) error {
		f.plan.Called("drain")
		f.requireAddress(ctx, f.project.ID, id)
		expected := store.TaskSessionDrain{SourceLifecycle: "active", GraceSeconds: 60, TimelineField: "lastTimelineSeq", LifecycleField: "lifecycle", RemoveFields: []string{"cleanupInteractionIds", "controls", "turnStartedAt", "currentTurnId"}, SnapshotValues: map[string]any{"lifecycle": "draining", "synchronized": false, "connectionState": "disconnected", "activity": "unknown"}}
		if !reflect.DeepEqual(drain, expected) {
			f.fail("lifecycle drain=%#v want=%#v", drain, expected)
		}
		return nil
	}
	sessions.TransitionTaskSessionReceiptsFn = func(ctx context.Context, id string, transition store.TaskSessionReceiptTransition) error {
		f.plan.Called("receipts")
		f.requireAddress(ctx, f.project.ID, id)
		if !reflect.DeepEqual(transition, store.TaskSessionReceiptTransition{LifecycleField: "lifecycle", Lifecycle: "draining", StateField: "state", PreviousState: "accepted", NextState: "rejected", RemoveFields: []string{"error"}}) {
			f.fail("lifecycle transition changed receipt policy")
		}
		return nil
	}
	capture := &taskHTTPCaptureDAOMock{taskHTTPMockBase: base}
	capture.FreezeAudienceFn = func(ctx context.Context, project string, types []string) ([]store.WebhookAudience, error) {
		f.plan.Called("capture")
		if project != f.project.ID || !reflect.DeepEqual(types, []string{protocol.StatusChanged}) || ctx.Err() != nil {
			f.fail("lifecycle status capture changed scope/type")
		}
		return []store.WebhookAudience{}, nil
	}
	scope := &taskHTTPProjectScopeMock{taskHTTPMockBase: base, ProjectDAOFn: func() store.ProjectWriteDAO { return project }, TaskDAOFn: func() store.TaskWriteDAO { return writer }, SessionDAOFn: func() store.ProjectSessionDAO { return sessions }, CaptureDAOFn: func() store.WebhookCaptureDAO { return capture }}
	f.database.WriteProjectCall = func(ctx context.Context, project string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
		f.plan.Called("projectWrite")
		if project != f.project.ID {
			f.fail("lifecycle transaction changed Project")
		}
		err := run(scope)
		return store.Completion{Outcome: completion}, err
	}
	f.database.ReadSnapshotCall = nil
}

func lifecycleMutationCalls(patch bool) map[string]int {
	calls := taskCredentialCalls("projectWrite", "access", "task", "update", "drain", "receipts")
	if patch {
		calls["dependencies"], calls["reachable"] = 1, 1
	} else {
		calls["capture"] = 1
	}
	return calls
}

func assertLifecycleTask(t *testing.T, actual api.Task, expected model.Task) {
	t.Helper()
	expected = copyTaskHTTPTask(expected)
	resource := api.Task{ID: expected.ID, Type: expected.Type, ParentID: expected.ParentID, ProjectID: expected.ProjectID, Title: expected.Title, Description: expected.Description, Properties: api.TaskProperties(expected.Properties), Tags: tagHTTPReferences(expected.Tags), Status: string(expected.Status), Version: expected.Version, CreatedAt: expected.CreatedAt, UpdatedAt: expected.UpdatedAt, StartedAt: expected.StartedAt, CompletedAt: expected.CompletedAt, CancelledAt: expected.CancelledAt, DependsOn: expected.DependsOn, ExternalDependsOn: expected.ExternalDependsOn, BlockedBy: expected.BlockedBy, AssignedTo: expected.AssignedTo, AllowAgents: expected.AllowAgents, Ready: expected.Ready}
	if !reflect.DeepEqual(actual, resource) {
		t.Fatalf("lifecycle result=%#v want=%#v", actual, resource)
	}
}
func TestTaskLifecycleAuthenticationAndMemberAccess(t *testing.T) {
	f := newTaskCredentialFixture(t)
	member := defaultHTTPPrincipal()
	memberSession := member
	memberSession.Kind, memberSession.CredentialID = model.SessionCredential, "77777777-7777-4777-8777-777777777777"
	admin := model.Principal{UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222", Kind: model.SessionCredential}
	outsider := model.Principal{UserID: "99999999-9999-4999-8999-999999999999", CredentialID: "88888888-8888-4888-8888-888888888888", Kind: model.SessionCredential}
	session := map[string]string{"Cookie": "__Host-daynight_session=" + httpTestToken(model.SessionCredential), "Origin": f.origin}
	foreign := map[string]string{"Cookie": session["Cookie"], "Origin": "https://foreign.example"}
	bearer := map[string]string{"Authorization": "Bearer " + defaultHTTPToken()}
	prerequisite := f.task
	prerequisite.ID, prerequisite.Title, prerequisite.Status = "66666666-6666-4666-8666-666666666666", "Completed external prerequisite", model.TaskDone
	current := f.task
	current.Title, current.Description = "Member workflow", "Original"
	current.DependsOn, current.ExternalDependsOn = []string{prerequisite.ID}, []string{prerequisite.ID}
	path := "/api/v1/projects/" + f.project.ID + "/tasks/" + current.ID
	next := current
	next.Description, next.AllowAgents, next.Version, next.UpdatedAt = "Revised by a member", true, 2, current.UpdatedAt.Add(time.Second)
	f.expectLifecycleMutation(current, next, prerequisite, true, nil, store.TransactionCommitted)
	response := f.request(memberSession, http.MethodPatch, path, map[string]any{"version": current.Version, "description": "Revised by a member", "allowAgents": true}, session, 200, "", lifecycleMutationCalls(true))
	assertLifecycleTask(t, taskCredentialDecode[api.Task](t, response), next)
	current = next

	guardPatch := func(body any, after model.Task) {
		t.Helper()
		f.expectLifecycleMutation(current, after, prerequisite, true, nil, store.TransactionCommitted)
		f.request(model.Principal{}, http.MethodPatch, path, body, nil, 401, "unauthenticated", map[string]int{})
		f.expectLifecycleMutation(current, after, prerequisite, true, model.ErrNotFound, store.TransactionCommitted)
		f.request(outsider, http.MethodPatch, path, body, session, 404, "not_found", taskCredentialCalls("projectWrite", "access"))
		f.expectLifecycleMutation(current, after, prerequisite, true, nil, store.TransactionCommitted)
		f.request(memberSession, http.MethodPatch, path, body, foreign, 403, "forbidden", taskCredentialCalls())
	}
	next = current
	next.AllowAgents, next.Version, next.UpdatedAt = false, 3, current.UpdatedAt.Add(time.Second)
	disable := map[string]any{"version": current.Version, "allowAgents": false}
	guardPatch(disable, next)
	f.expectLifecycleMutation(current, next, prerequisite, true, nil, store.TransactionCommitted)
	response = f.request(member, http.MethodPatch, path, disable, bearer, 200, "", lifecycleMutationCalls(true))
	assertLifecycleTask(t, taskCredentialDecode[api.Task](t, response), next)
	current = next
	next = current
	next.ExternalDependsOn, next.Version, next.UpdatedAt = []string{}, 4, current.UpdatedAt.Add(time.Second)
	classify := map[string]any{"version": current.Version, "externalDependsOn": []string{}}
	guardPatch(classify, next)
	f.expectLifecycleMutation(current, next, prerequisite, true, nil, store.TransactionCommitted)
	response = f.request(member, http.MethodPatch, path, classify, bearer, 200, "", lifecycleMutationCalls(true))
	assertLifecycleTask(t, taskCredentialDecode[api.Task](t, response), next)
	current = next
	next = current
	next.ExternalDependsOn, next.Version, next.UpdatedAt = []string{prerequisite.ID}, 5, current.UpdatedAt.Add(time.Second)
	f.expectLifecycleMutation(current, next, prerequisite, true, nil, store.TransactionCommitted)
	response = f.request(memberSession, http.MethodPatch, path, map[string]any{"version": current.Version, "externalDependsOn": []string{prerequisite.ID}}, session, 200, "", lifecycleMutationCalls(true))
	assertLifecycleTask(t, taskCredentialDecode[api.Task](t, response), next)
	current = next
	for _, status := range []model.TaskStatus{model.TaskInProgress, model.TaskTodo, model.TaskDone} {
		t.Run(string(status), func(t *testing.T) {
			next := current
			next.Status, next.Version, next.UpdatedAt, next.Ready = status, current.Version+1, current.UpdatedAt.Add(time.Second), status == model.TaskTodo
			if status == model.TaskInProgress {
				next.StartedAt = &next.UpdatedAt
			}
			if status == model.TaskTodo {
				next.StartedAt, next.CompletedAt = nil, nil
			}
			if status == model.TaskDone {
				next.CompletedAt = &next.UpdatedAt
			}
			body := api.TaskStatusUpdateRequest{Version: current.Version, Status: string(status)}
			f.expectLifecycleMutation(current, next, prerequisite, false, nil, store.TransactionCommitted)
			for _, method := range []string{http.MethodPut, http.MethodDelete} {
				f.request(model.Principal{}, method, path+"/status", body, nil, 401, "unauthenticated", map[string]int{})
			}
			f.request(memberSession, http.MethodPut, path+"/status", body, foreign, 403, "forbidden", taskCredentialCalls())
			f.expectLifecycleMutation(current, next, prerequisite, false, model.ErrNotFound, store.TransactionCommitted)
			f.request(outsider, http.MethodPut, path+"/status", body, session, 404, "not_found", taskCredentialCalls("projectWrite", "access"))
			f.expectRead(current, nil)
			response := f.request(memberSession, http.MethodGet, path, nil, session, 200, "", taskCredentialCalls("snapshot", "access", "task", "epoch"))
			assertLifecycleTask(t, taskCredentialDecode[api.Task](t, response), current)
			f.expectLifecycleMutation(current, next, prerequisite, false, nil, store.TransactionCommitted)
			actor, headers := member, map[string]string{"Authorization": bearer["Authorization"], "X-Request-ID": "lifecycle-member-" + string(status)}
			if status == model.TaskDone {
				actor, headers = memberSession, map[string]string{"Cookie": session["Cookie"], "Origin": f.origin, "X-Request-ID": "lifecycle-member-done"}
			}
			response = f.request(actor, http.MethodPut, path+"/status", body, headers, 200, "", lifecycleMutationCalls(false))
			assertLifecycleTask(t, taskCredentialDecode[api.Task](t, response), next)
			current = next
		})
	}
	f.authenticationError = model.ErrNotFound
	for _, status := range []string{"todo", "in_progress", "done"} {
		body := api.TaskStatusUpdateRequest{Version: current.Version, Status: status}
		f.request(member, http.MethodPut, path+"/status", body, bearer, 401, "unauthenticated", taskCredentialCalls())
		f.request(memberSession, http.MethodPut, path+"/status", body, session, 401, "unauthenticated", taskCredentialCalls())
	}
	f.authenticationError = nil
	f.expectRead(current, nil)
	response = f.request(admin, http.MethodGet, path, nil, session, 200, "", taskCredentialCalls("snapshot", "access", "task", "epoch"))
	assertLifecycleTask(t, taskCredentialDecode[api.Task](t, response), current)
	for _, status := range []string{"todo", "in_progress", "done"} {
		found := false
		for line := range strings.SplitSeq(f.logs.String(), "\n") {
			var entry map[string]any
			if json.Unmarshal([]byte(line), &entry) == nil && entry["component"] == "task" && entry["phase"] == "set_status" && entry["request_id"] == "lifecycle-member-"+status && entry["user_id"] == member.UserID {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s did not log authenticated member and request ID", status)
		}
	}
	for _, credential := range []string{defaultHTTPToken(), httpTestToken(model.SessionCredential)} {
		if strings.Contains(f.logs.String(), credential) {
			t.Fatal("lifecycle diagnostics exposed credential")
		}
	}
}
