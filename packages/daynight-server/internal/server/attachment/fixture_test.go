package attachment_test

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	attachmenthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/attachment"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type resourceTestHandler struct {
	http.Handler
	token     string
	principal model.Principal
}

type attachmentFixture struct {
	t          *testing.T
	handler    *resourceTestHandler
	mux        *http.ServeMux
	task       api.Task
	project    api.Project
	dao        *attachmentDAOMock
	snapshots  *snapshotMock
	mutations  *mutationMock
	mu         sync.Mutex
	want, seen map[string]int
}

func newAttachmentFixture(t *testing.T, files filestorage.Storage, output io.Writer) *attachmentFixture {
	return newAttachmentFixtureWithTimeout(t, files, output, attachmenthttp.DefaultBodyReadTimeout())
}

func newAttachmentFixtureWithTimeout(t *testing.T, files filestorage.Storage, output io.Writer, timeout time.Duration) *attachmentFixture {
	t.Helper()
	f := &attachmentFixture{t: t, mux: http.NewServeMux(), want: map[string]int{}, seen: map[string]int{}}
	f.project = api.Project{ID: uuid.NewString(), Name: "Attachment project"}
	f.task = api.Task{ID: uuid.NewString(), ProjectID: f.project.ID, Title: "Attached task", Status: "todo", Version: 3}
	principal := model.Principal{UserID: uuid.NewString(), CredentialID: uuid.NewString(), Kind: model.PATCredential}
	f.handler = &resourceTestHandler{token: "dnpat_" + strings.Repeat("A", 43), principal: principal}
	reject := unexpectedDAO{t: t}
	f.dao = &attachmentDAOMock{unexpectedDAO: reject}
	f.snapshots = &snapshotMock{unexpectedDAO: reject}
	f.mutations = &mutationMock{unexpectedDAO: reject}
	identity := &authenticationMock{unexpectedDAO: reject, principal: principal, hash: secret.Hash(f.handler.token)}
	logger := slog.New(slog.NewJSONHandler(output, nil))
	auth, err := authhttp.NewAuthentication(identityservice.New(identity, nil, "https://daynight.example/api/v1/auth/callback"), authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	attachmenthttp.RegisterRoutesWithBodyReadTimeout(f.mux, attachmentservice.NewAttachments(f.snapshots, f.mutations, files), auth, logger, timeout)
	f.handler.Handler = httpx.RequestLogging(logger, attachmenthttp.PathGuard(f.mux, logger))
	t.Cleanup(f.verify)
	return f
}

func (f *attachmentFixture) item(task api.Task, path, mime string, size int64) model.Attachment {
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	return model.Attachment{ProjectID: task.ProjectID, TaskID: task.ID, Path: path, ContentType: mime, SizeBytes: size, CreatedAt: at, UpdatedAt: at}
}

func (f *attachmentFixture) require(name string, count int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.want[name] += count
}
func (f *attachmentFixture) called(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seen[name]++
	if f.seen[name] > f.want[name] {
		f.t.Errorf("unexpected DAO call %s (%d, expected %d)", name, f.seen[name], f.want[name])
		panic("unexpected DAO call")
	}
}
func (f *attachmentFixture) verify() {
	f.t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for name, want := range f.want {
		if f.seen[name] != want {
			f.t.Errorf("DAO call %s: got %d, want %d", name, f.seen[name], want)
		}
	}
}
func (f *attachmentFixture) begin() {
	f.verify()
	f.mu.Lock()
	f.want = map[string]int{}
	f.seen = map[string]int{}
	f.mu.Unlock()
	f.dao.attachmentFn = nil
	f.dao.attachmentsFn = nil
	f.dao.conflictFn = nil
	f.dao.putFn = nil
	f.dao.deleteFn = nil
	f.snapshots.readFn = nil
	f.mutations.writeFn = nil
}
func (f *attachmentFixture) checkIDs(task api.Task, project, taskID string) {
	f.t.Helper()
	if project != task.ProjectID || taskID != task.ID {
		f.t.Errorf("DAO address = %s/%s, want %s/%s", project, taskID, task.ProjectID, task.ID)
	}
}
func (f *attachmentFixture) access(task api.Task, p model.Principal, project string, err error) (model.ProjectAccess, error) {
	if p != f.handler.principal || project != task.ProjectID {
		f.t.Errorf("authorization arguments = %+v/%s", p, project)
	}
	return model.ProjectAccess{ProjectID: project, UserID: p.UserID, Role: model.ProjectAdmin}, err
}
func (f *attachmentFixture) snapshot(task api.Task, accessErr error, presence store.TaskPresence) {
	f.require("snapshot", 1)
	f.require("access", 1)
	if accessErr == nil {
		f.require("presence", 1)
		if presence.Found && presence.DeletedAt == nil {
			f.require("read attachment DAO", 1)
		}
	}
	f.snapshots.readFn = func(ctx context.Context, fn func(store.SnapshotScope) error) error {
		f.called("snapshot")
		scope := &attachmentSnapshot{unexpectedDAO: unexpectedDAO{t: f.t}}
		scope.project = &projectReadMock{unexpectedProjectReader: unexpectedProjectReader{unexpectedDAO{t: f.t}}, accessFn: func(_ context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
			f.called("access")
			return f.access(task, p, id, accessErr)
		}}
		scope.task = &taskReadMock{unexpectedTaskReader: unexpectedTaskReader{unexpectedDAO{t: f.t}}, presenceFn: func(_ context.Context, p, id string) (store.TaskPresence, error) {
			f.called("presence")
			f.checkIDs(task, p, id)
			return presence, nil
		}}
		scope.attachmentFn = func() store.AttachmentReader { f.called("read attachment DAO"); return f.dao }
		return fn(scope)
	}
}
func (f *attachmentFixture) mutation(task api.Task, authorization bool, presence store.TaskPresence, accessErr error) {
	f.require("mutation", 1)
	f.require("lock presence", 1)
	if authorization {
		f.require("mutation access", 1)
	} else {
		f.require("live", 1)
	}
	if accessErr == nil && presence.Found && presence.DeletedAt == nil {
		f.require("mutation attachment DAO", 1)
	}
	f.mutations.writeFn = func(ctx context.Context, fn func(store.AttachmentMutationScope) error) (store.Completion, error) {
		f.called("mutation")
		scope := &attachmentMutation{unexpectedDAO: unexpectedDAO{t: f.t}}
		scope.presenceFn = func(_ context.Context, p, id string) (store.TaskPresence, error) {
			f.called("lock presence")
			f.checkIDs(task, p, id)
			return presence, nil
		}
		scope.accessFn = func(_ context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
			f.called("mutation access")
			return f.access(task, p, id, accessErr)
		}
		scope.liveFn = func(_ context.Context, id string) error {
			f.called("live")
			if id != task.ProjectID {
				f.t.Errorf("ProjectLive(%s)", id)
			}
			return accessErr
		}
		scope.attachmentFn = func() store.AttachmentMutationDAO { f.called("mutation attachment DAO"); return f.dao }
		err := fn(scope)
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
}
func (f *attachmentFixture) expectRead(task api.Task, path string, item model.Attachment, err error) {
	f.begin()
	f.snapshot(task, nil, store.TaskPresence{Found: true})
	f.require("attachment", 1)
	f.dao.attachmentFn = func(_ context.Context, p, id, name string) (model.Attachment, error) {
		f.called("attachment")
		f.checkIDs(task, p, id)
		if name != path {
			f.t.Errorf("Attachment path=%q want%q", name, path)
		}
		return item, err
	}
}
func (f *attachmentFixture) expectList(task api.Task, query store.AttachmentQuery, page store.AttachmentPage, err error) {
	f.begin()
	f.snapshot(task, nil, store.TaskPresence{Found: true})
	f.require("attachments", 1)
	f.dao.attachmentsFn = func(_ context.Context, p, id string, actual store.AttachmentQuery) (store.AttachmentPage, error) {
		f.called("attachments")
		f.checkIDs(task, p, id)
		if !reflect.DeepEqual(actual, query) {
			f.t.Errorf("Attachments query=%+v want%+v", actual, query)
		}
		return page, err
	}
}
func (f *attachmentFixture) conflict(task api.Task, path string, value bool, err error) {
	f.require("conflict", 1)
	f.dao.conflictFn = func(_ context.Context, p, id string, q store.AttachmentConflictQuery) (bool, error) {
		f.called("conflict")
		f.checkIDs(task, p, id)
		expected := store.AttachmentConflictQuery{Ancestors: []string{}, DescendantPrefix: path + "/"}
		for i, char := range path {
			if char == '/' {
				expected.Ancestors = append(expected.Ancestors, path[:i])
			}
		}
		if !reflect.DeepEqual(q, expected) {
			f.t.Errorf("conflict query=%+v want%+v", q, expected)
		}
		return value, err
	}
}
func (f *attachmentFixture) expectAdmission(task api.Task, path string) {
	f.begin()
	f.snapshot(task, nil, store.TaskPresence{Found: true})
	f.mutation(task, false, store.TaskPresence{Found: true}, nil)
	f.conflict(task, path, false, nil)
}
func (f *attachmentFixture) expectPut(task api.Task, path, mime string, size int64, result model.Attachment, created bool) {
	f.expectAdmission(task, path)
	f.require("put attachment", 1)
	f.dao.putFn = func(_ context.Context, item model.Attachment) (model.Attachment, bool, error) {
		f.called("put attachment")
		expected := model.Attachment{ProjectID: task.ProjectID, TaskID: task.ID, Path: path, ContentType: mime, SizeBytes: size}
		if !reflect.DeepEqual(item, expected) {
			f.t.Errorf("PutAttachment=%+v want%+v", item, expected)
		}
		return result, created, nil
	}
}
func (f *attachmentFixture) expectConflict(task api.Task, path string) {
	f.begin()
	f.snapshot(task, nil, store.TaskPresence{Found: true})
	f.mutation(task, false, store.TaskPresence{Found: true}, nil)
	f.conflict(task, path, true, nil)
}
func (f *attachmentFixture) expectPutError(task api.Task, path string, err error) {
	f.begin()
	f.snapshot(task, nil, store.TaskPresence{Found: true})
	f.mutation(task, false, store.TaskPresence{Found: true}, nil)
	f.conflict(task, path, false, err)
}
func (f *attachmentFixture) expectReadFailure(task api.Task, accessErr error, presence store.TaskPresence) {
	f.begin()
	f.snapshot(task, accessErr, presence)
}
func (f *attachmentFixture) prepareReadFailure(task api.Task, accessErr error, presence store.TaskPresence) {
	f.snapshot(task, accessErr, presence)
}

func (f *attachmentFixture) expectMutationFailure(task api.Task, authorization bool, presence store.TaskPresence, accessErr error) {
	f.mutation(task, authorization, presence, accessErr)
}
func (f *attachmentFixture) expectDelete(task api.Task, item model.Attachment) {
	f.begin()
	f.mutation(task, true, store.TaskPresence{Found: true}, nil)
	f.require("attachment", 1)
	f.require("delete attachment", 1)
	f.dao.attachmentFn = func(_ context.Context, p, id, path string) (model.Attachment, error) {
		f.called("attachment")
		f.checkIDs(task, p, id)
		if path != item.Path {
			f.t.Errorf("delete read path=%q", path)
		}
		return item, nil
	}
	f.dao.deleteFn = func(_ context.Context, p, id, path string) error {
		f.called("delete attachment")
		f.checkIDs(task, p, id)
		if path != item.Path {
			f.t.Errorf("delete path=%q", path)
		}
		return nil
	}
}
func (f *attachmentFixture) expectDeleteMissing(task api.Task, path string) {
	f.begin()
	f.mutation(task, true, store.TaskPresence{Found: true}, nil)
	f.require("attachment", 1)
	f.dao.attachmentFn = func(_ context.Context, p, id, name string) (model.Attachment, error) {
		f.called("attachment")
		f.checkIDs(task, p, id)
		if name != path {
			f.t.Errorf("delete missing path=%q", name)
		}
		return model.Attachment{}, model.ErrNotFound
	}
}

func authorizeResourceRequest(handler http.Handler, request *http.Request) {
	if h, ok := handler.(*resourceTestHandler); ok {
		request.Header.Set("Authorization", "Bearer "+h.token)
	}
}
func projectRequest(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	authorizeResourceRequest(handler, request)
	request.Header.Set("Content-Type", "application/json; charset=UTF-8")
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
func decodeResponse[T any](t *testing.T, response *httptest.ResponseRecorder, status int) T {
	return testsupport.DecodeResponse[T](t, response, status)
}
func assertProjectError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	testsupport.AssertProjectError(t, response, status, code)
}
func jsonBody(t *testing.T, input any) string { return testsupport.JSONBody(t, input) }
func taskCollection(id string) string         { return "/api/v1/projects/" + id + "/tasks" }
func taskPath(task api.Task) string           { return taskCollection(task.ProjectID) + "/" + task.ID }
func uiTestHandler(t *testing.T, output io.Writer) http.Handler {
	logger := slog.New(slog.NewJSONHandler(output, nil))
	mux := http.NewServeMux()
	return httpx.RequestLogging(logger, attachmenthttp.PathGuard(mux, logger))
}

type unexpectedDAO struct{ t *testing.T }

func (u unexpectedDAO) reject(name string) {
	u.t.Helper()
	u.t.Errorf("unexpected DAO access: %s", name)
	panic("unexpected DAO access")
}

type attachmentDAOMock struct {
	unexpectedDAO
	attachmentFn  func(context.Context, string, string, string) (model.Attachment, error)
	attachmentsFn func(context.Context, string, string, store.AttachmentQuery) (store.AttachmentPage, error)
	conflictFn    func(context.Context, string, string, store.AttachmentConflictQuery) (bool, error)
	putFn         func(context.Context, model.Attachment) (model.Attachment, bool, error)
	deleteFn      func(context.Context, string, string, string) error
}

func (d *attachmentDAOMock) Attachment(ctx context.Context, p, t, path string) (model.Attachment, error) {
	if d.attachmentFn == nil {
		d.reject("Attachment")
	}
	return d.attachmentFn(ctx, p, t, path)
}
func (d *attachmentDAOMock) AttachmentBounded(context.Context, string, string, string, int) (model.Attachment, bool, error) {
	d.reject("AttachmentBounded")
	panic("unreachable")
}
func (d *attachmentDAOMock) Attachments(ctx context.Context, p, t string, q store.AttachmentQuery) (store.AttachmentPage, error) {
	if d.attachmentsFn == nil {
		d.reject("Attachments")
	}
	return d.attachmentsFn(ctx, p, t, q)
}
func (d *attachmentDAOMock) AttachmentPathConflict(ctx context.Context, p, t string, q store.AttachmentConflictQuery) (bool, error) {
	if d.conflictFn == nil {
		d.reject("AttachmentPathConflict")
	}
	return d.conflictFn(ctx, p, t, q)
}
func (d *attachmentDAOMock) PutAttachment(ctx context.Context, item model.Attachment) (model.Attachment, bool, error) {
	if d.putFn == nil {
		d.reject("PutAttachment")
	}
	return d.putFn(ctx, item)
}
func (d *attachmentDAOMock) DeleteAttachment(ctx context.Context, p, t, path string) error {
	if d.deleteFn == nil {
		d.reject("DeleteAttachment")
	}
	return d.deleteFn(ctx, p, t, path)
}

type snapshotMock struct {
	unexpectedDAO
	readFn func(context.Context, func(store.SnapshotScope) error) error
}

func (s *snapshotMock) ReadSnapshot(ctx context.Context, fn func(store.SnapshotScope) error) error {
	if s.readFn == nil {
		s.reject("ReadSnapshot")
	}
	return s.readFn(ctx, fn)
}

type mutationMock struct {
	unexpectedDAO
	writeFn func(context.Context, func(store.AttachmentMutationScope) error) (store.Completion, error)
}

func (s *mutationMock) WriteAttachmentMutation(ctx context.Context, fn func(store.AttachmentMutationScope) error) (store.Completion, error) {
	if s.writeFn == nil {
		s.reject("WriteAttachmentMutation")
	}
	return s.writeFn(ctx, fn)
}

type attachmentSnapshot struct {
	unexpectedDAO
	project      store.ProjectReader
	task         store.TaskReader
	attachmentFn func() store.AttachmentReader
}

func (s *attachmentSnapshot) ProjectDAO() store.ProjectReader       { return s.project }
func (s *attachmentSnapshot) TaskDAO() store.TaskReader             { return s.task }
func (s *attachmentSnapshot) AttachmentDAO() store.AttachmentReader { return s.attachmentFn() }
func (s *attachmentSnapshot) CredentialDAO() store.CredentialReader {
	s.reject("CredentialDAO")
	return nil
}
func (s *attachmentSnapshot) TeamDAO() store.TeamReader       { s.reject("TeamDAO"); return nil }
func (s *attachmentSnapshot) WorkerDAO() store.WorkerReader   { s.reject("WorkerDAO"); return nil }
func (s *attachmentSnapshot) SessionDAO() store.SessionReader { s.reject("SessionDAO"); return nil }
func (s *attachmentSnapshot) BotDAO() store.BotReader         { s.reject("BotDAO"); return nil }
func (s *attachmentSnapshot) ObservedAt(context.Context) (time.Time, error) {
	s.reject("ObservedAt")
	return time.Time{}, nil
}

type attachmentMutation struct {
	unexpectedDAO
	presenceFn   func(context.Context, string, string) (store.TaskPresence, error)
	accessFn     func(context.Context, model.Principal, string) (model.ProjectAccess, error)
	liveFn       func(context.Context, string) error
	attachmentFn func() store.AttachmentMutationDAO
}

func (s *attachmentMutation) LockTaskPresence(ctx context.Context, p, t string) (store.TaskPresence, error) {
	return s.presenceFn(ctx, p, t)
}
func (s *attachmentMutation) ProjectAuthorization(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
	return s.accessFn(ctx, p, id)
}
func (s *attachmentMutation) ProjectLive(ctx context.Context, id string) error {
	return s.liveFn(ctx, id)
}
func (s *attachmentMutation) AttachmentDAO() store.AttachmentMutationDAO { return s.attachmentFn() }
func (s *attachmentMutation) UploadChunkAt(context.Context, string, int64) (model.UploadChunk, error) {
	s.reject("UploadChunkAt")
	return model.UploadChunk{}, nil
}

type projectReadMock struct {
	unexpectedProjectReader
	accessFn func(context.Context, model.Principal, string) (model.ProjectAccess, error)
}

func (s *projectReadMock) ProjectAccess(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
	return s.accessFn(ctx, p, id)
}

type taskReadMock struct {
	unexpectedTaskReader
	presenceFn func(context.Context, string, string) (store.TaskPresence, error)
}

func (s *taskReadMock) TaskPresence(ctx context.Context, p, id string) (store.TaskPresence, error) {
	return s.presenceFn(ctx, p, id)
}

type authenticationMock struct {
	unexpectedDAO
	principal model.Principal
	hash      []byte
}

func (s *authenticationMock) WriteIdentity(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
	err := fn(s)
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func (s *authenticationMock) IdentityDAO() store.IdentityDAO {
	return &authenticationDAO{unexpectedIdentityDAO: unexpectedIdentityDAO{s.unexpectedDAO}, principal: s.principal, hash: s.hash}
}
func (s *authenticationMock) CredentialFamilyDAO() store.CredentialFamilyDAO {
	s.reject("CredentialFamilyDAO")
	panic("unreachable")
}
func (s *authenticationMock) PersonalTeamDAO() store.PersonalTeamDAO {
	s.reject("PersonalTeamDAO")
	return nil
}

type authenticationDAO struct {
	unexpectedIdentityDAO
	principal model.Principal
	hash      []byte
}

func (s *authenticationDAO) Authenticate(_ context.Context, kind model.CredentialKind, hash []byte, at time.Time) (model.Principal, error) {
	if kind != model.PATCredential || !bytes.Equal(hash, s.hash) || at.IsZero() {
		s.reject("Authenticate arguments")
	}
	return s.principal, nil
}

type unexpectedProjectReader struct{ unexpectedDAO }

func (s *unexpectedProjectReader) Project(context.Context, string) (model.Project, error) {
	s.reject("Project")
	panic("unreachable")
}
func (s *unexpectedProjectReader) Projects(context.Context, store.Page) (store.ProjectPage, error) {
	s.reject("Projects")
	panic("unreachable")
}
func (s *unexpectedProjectReader) DirectProjectMember(context.Context, string, string) (model.ProjectMember, error) {
	s.reject("DirectProjectMember")
	panic("unreachable")
}
func (s *unexpectedProjectReader) ProjectParticipants(context.Context, string) ([]model.ProjectParticipant, error) {
	s.reject("ProjectParticipants")
	panic("unreachable")
}
func (s *unexpectedProjectReader) Invitation(context.Context, []byte) (model.ProjectInvitation, error) {
	s.reject("Invitation")
	panic("unreachable")
}
func (s *unexpectedProjectReader) Invitations(context.Context, string, time.Time) ([]model.ProjectInvitation, error) {
	s.reject("Invitations")
	panic("unreachable")
}
func (s *unexpectedProjectReader) ProjectAccess(context.Context, model.Principal, string) (model.ProjectAccess, error) {
	s.reject("ProjectAccess")
	panic("unreachable")
}
func (s *unexpectedProjectReader) AccessibleProjects(context.Context, model.Principal, store.Page) (store.ProjectPage, error) {
	s.reject("AccessibleProjects")
	panic("unreachable")
}
func (s *unexpectedProjectReader) ScopedProjects(context.Context, model.Principal, store.ProjectScope, store.Page) (store.ProjectPage, error) {
	s.reject("ScopedProjects")
	panic("unreachable")
}
func (s *unexpectedProjectReader) TransferTeam(context.Context, string) (store.TransferTeam, error) {
	s.reject("TransferTeam")
	panic("unreachable")
}
func (s *unexpectedProjectReader) TransferRole(context.Context, string, string, string) (*model.ProjectRole, error) {
	s.reject("TransferRole")
	panic("unreachable")
}

type unexpectedTaskReader struct{ unexpectedDAO }

func (s *unexpectedTaskReader) TaskBodies(context.Context, string, []string) ([]model.Task, error) {
	s.reject("TaskBodies")
	panic("unreachable")
}
func (s *unexpectedTaskReader) GoalProgresses(context.Context, string, []string) (map[string]model.GoalProgress, error) {
	s.reject("GoalProgresses")
	panic("unreachable")
}
func (s *unexpectedTaskReader) Task(context.Context, string, string) (model.Task, error) {
	s.reject("Task")
	panic("unreachable")
}
func (s *unexpectedTaskReader) Tasks(context.Context, string, store.TaskQuery) (store.TaskPage, error) {
	s.reject("Tasks")
	panic("unreachable")
}
func (s *unexpectedTaskReader) TaskListFence(context.Context, string) (store.TaskListFence, error) {
	s.reject("TaskListFence")
	panic("unreachable")
}
func (s *unexpectedTaskReader) TaskPriorityList(context.Context, string, store.TaskPriorityQuery) (store.TaskPriorityPage, error) {
	s.reject("TaskPriorityList")
	panic("unreachable")
}
func (s *unexpectedTaskReader) TaskPresence(context.Context, string, string) (store.TaskPresence, error) {
	s.reject("TaskPresence")
	panic("unreachable")
}
func (s *unexpectedTaskReader) TaskHeader(context.Context, string, string) (model.TaskHeader, error) {
	s.reject("TaskHeader")
	panic("unreachable")
}
func (s *unexpectedTaskReader) TaskStep(context.Context, string, string) (model.TaskStep, error) {
	s.reject("TaskStep")
	panic("unreachable")
}
func (s *unexpectedTaskReader) TaskSteps(context.Context, string) ([]model.TaskStep, error) {
	s.reject("TaskSteps")
	panic("unreachable")
}
func (s *unexpectedTaskReader) TaskStepPage(context.Context, string, int64, int, bool) ([]store.TaskStepProjection, error) {
	s.reject("TaskStepPage")
	panic("unreachable")
}
func (s *unexpectedTaskReader) TaskStepSummary(context.Context, string, string) (store.TaskStepProjection, error) {
	s.reject("TaskStepSummary")
	panic("unreachable")
}
func (s *unexpectedTaskReader) ThreadMessage(context.Context, string, string) (model.ThreadMessage, error) {
	s.reject("ThreadMessage")
	panic("unreachable")
}
func (s *unexpectedTaskReader) ThreadCandidates(context.Context, string, *model.ThreadPosition, bool, int) ([]model.ThreadMessage, error) {
	s.reject("ThreadCandidates")
	panic("unreachable")
}
func (s *unexpectedTaskReader) ThreadSides(context.Context, string, model.ThreadPosition, model.ThreadPosition) (bool, bool, error) {
	s.reject("ThreadSides")
	panic("unreachable")
}
func (s *unexpectedTaskReader) TaskAssignees(context.Context, string) ([]model.TaskAssigneeFact, error) {
	s.reject("TaskAssignees")
	panic("unreachable")
}
func (s *unexpectedTaskReader) ResolveTaskAssignees(context.Context, string, []string) ([]model.TaskAssigneeFact, error) {
	s.reject("ResolveTaskAssignees")
	panic("unreachable")
}
func (s *unexpectedTaskReader) TaskGraphTasks(context.Context, string, string, store.TaskGraphSelection, int) ([]model.GraphTask, error) {
	s.reject("TaskGraphTasks")
	panic("unreachable")
}
func (s *unexpectedTaskReader) TaskCacheEpoch(context.Context, string) (string, error) {
	s.reject("TaskCacheEpoch")
	panic("unreachable")
}
func (s *unexpectedTaskReader) TaskSyncTasks(context.Context, string, *time.Time, int) ([]model.TaskViewRecord, error) {
	s.reject("TaskSyncTasks")
	panic("unreachable")
}

type unexpectedIdentityDAO struct{ unexpectedDAO }

func (s *unexpectedIdentityDAO) CleanupCredentials(context.Context, time.Time) error {
	s.reject("CleanupCredentials")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) CleanupLoginCredentials(context.Context, time.Time, time.Time) error {
	s.reject("CleanupLoginCredentials")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) AdmitLogin(context.Context, []byte, int, int) (time.Time, string, error) {
	s.reject("AdmitLogin")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) InsertLogin(context.Context, model.LoginTransaction) error {
	s.reject("InsertLogin")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) ConsumeLogin(context.Context, []byte, []byte, time.Time) (model.LoginTransaction, error) {
	s.reject("ConsumeLogin")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) UpsertUser(context.Context, model.User, time.Time) (model.User, error) {
	s.reject("UpsertUser")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) EnsureUser(context.Context, model.User, time.Time) (model.User, bool, error) {
	s.reject("EnsureUser")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) PatchUser(context.Context, string, model.UserProfilePatch) (model.User, error) {
	s.reject("PatchUser")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) InsertSession(context.Context, model.Session) error {
	s.reject("InsertSession")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) Authenticate(context.Context, model.CredentialKind, []byte, time.Time) (model.Principal, error) {
	s.reject("Authenticate")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) IdentityUser(context.Context, string) (model.User, store.PersonalTeamFacts, error) {
	s.reject("IdentityUser")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) IdentityPersonalTeam(context.Context, string) (store.PersonalTeamFacts, error) {
	s.reject("IdentityPersonalTeam")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) DeleteSession(context.Context, model.Principal) error {
	s.reject("DeleteSession")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) LockSession(context.Context, model.Principal, time.Time) error {
	s.reject("LockSession")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) InsertPAT(context.Context, model.PersonalAccessToken) error {
	s.reject("InsertPAT")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) ListPATs(context.Context, string, time.Time) ([]model.PersonalAccessToken, error) {
	s.reject("ListPATs")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) DeletePAT(context.Context, string, string) error {
	s.reject("DeletePAT")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) LockActivePAT(context.Context, string, string, time.Time) (model.PersonalAccessToken, error) {
	s.reject("LockActivePAT")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) SetPATExpiry(context.Context, string, *time.Time) (model.PersonalAccessToken, error) {
	s.reject("SetPATExpiry")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) PruneDeviceRates(context.Context, time.Time) error {
	s.reject("PruneDeviceRates")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) IncrementDeviceRate(context.Context, model.DeviceRateBucket, time.Time) (int, error) {
	s.reject("IncrementDeviceRate")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) PruneDevices(context.Context, time.Time) error {
	s.reject("PruneDevices")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) InsertDevice(context.Context, model.DeviceAuthorization) error {
	s.reject("InsertDevice")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) DeviceByUserCode(context.Context, string, string, bool) (model.DeviceAuthorization, error) {
	s.reject("DeviceByUserCode")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) LockDeviceByHash(context.Context, []byte) (model.DeviceAuthorization, error) {
	s.reject("LockDeviceByHash")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) SetDeviceDecision(context.Context, string, string, string) error {
	s.reject("SetDeviceDecision")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) DelayDevicePoll(context.Context, string, time.Time, bool) error {
	s.reject("DelayDevicePoll")
	panic("unreachable")
}
func (s *unexpectedIdentityDAO) ConsumeDevice(context.Context, string) error {
	s.reject("ConsumeDevice")
	panic("unreachable")
}

func (s *unexpectedTaskReader) TaskWorkGroups(context.Context, string, store.TaskWorkQuery) (store.TaskWorkGroups, error) {
	s.reject("TaskWorkGroups")
	panic("unreachable")
}
func (s *unexpectedTaskReader) TaskWorkTargets(context.Context, string, []string, *store.TaskWorkTargetPosition, int) (store.TaskWorkTargets, error) {
	s.reject("TaskWorkTargets")
	panic("unreachable")
}

func (s *unexpectedTaskReader) TaskSyncDependencyStates(context.Context, string, *time.Time) (map[string]model.TaskDependencyState, error) {
	s.reject("TaskSyncDependencyStates")
	panic("unreachable")
}
