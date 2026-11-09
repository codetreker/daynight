package attachment

import (
	"context"
	"errors"
	"os"
	"reflect"
	"sync"
	"testing"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestMain(m *testing.M) {
	for _, key := range []string{"DAYNIGHT_TEST_DATABASE_URL", "DAYNIGHT_TEST_UNIAUTH_FIXTURE"} {
		if err := os.Unsetenv(key); err != nil {
			panic(err)
		}
	}
	os.Exit(m.Run())
}

type attachmentExpectation struct {
	ctx           context.Context
	name          string
	args          []any
	result        any
	err           error
	after         func()
	completion    store.Completion
	callback      bool
	callbackError func(error) error
}

// Each plan belongs to one logical operation. Returned facts never follow from
// captured writes; callbacks and completion outcomes are configured separately.
type attachmentMock struct {
	store.ProjectReader
	store.TaskReader
	store.AttachmentMutationScope
	t    *testing.T
	mu   sync.Mutex
	plan []*attachmentExpectation
}

func newAttachmentMock(t *testing.T) *attachmentMock {
	t.Helper()
	m := &attachmentMock{t: t}
	t.Cleanup(func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if len(m.plan) > 0 {
			t.Errorf("unconsumed attachment call: %s (%d remaining)", m.plan[0].name, len(m.plan))
		}
	})
	return m
}
func (m *attachmentMock) expect(name string, args ...any) *attachmentExpectation {
	m.t.Helper()
	e := &attachmentExpectation{name: name, args: args}
	m.mu.Lock()
	m.plan = append(m.plan, e)
	m.mu.Unlock()
	return e
}
func (m *attachmentMock) take(ctx context.Context, name string, args ...any) *attachmentExpectation {
	m.t.Helper()
	m.mu.Lock()
	if len(m.plan) == 0 {
		m.mu.Unlock()
		m.t.Errorf("unexpected attachment call %s(%#v)", name, args)
		return &attachmentExpectation{err: errors.New("unexpected attachment call")}
	}
	e := m.plan[0]
	m.plan = m.plan[1:]
	m.mu.Unlock()
	if e.name != name || !reflect.DeepEqual(e.args, args) {
		m.t.Errorf("attachment call %s(%#v), want %s(%#v)", name, args, e.name, e.args)
		return &attachmentExpectation{err: errors.New("attachment call mismatch")}
	}
	if e.ctx != nil && e.ctx != ctx {
		m.t.Errorf("%s context was replaced", name)
	}
	if ctx == nil {
		m.t.Error("nil attachment context")
	}
	if e.after != nil {
		e.after()
	}
	return e
}
func (m *attachmentMock) ReadSnapshot(ctx context.Context, fn func(store.SnapshotScope) error) error {
	e := m.take(ctx, "snapshot")
	if e.callback {
		if err := fn(attachmentSnapshot{mock: m}); err != nil {
			return err
		}
	}
	return e.err
}
func (m *attachmentMock) WriteAttachmentMutation(ctx context.Context, fn func(store.AttachmentMutationScope) error) (store.Completion, error) {
	e := m.take(ctx, "mutation")
	if e.callback {
		if err := fn(m); err != nil {
			if e.callbackError != nil {
				err = e.callbackError(err)
			}
			return e.completion, err
		}
	}
	return e.completion, e.err
}

type attachmentSnapshot struct {
	store.SnapshotScope
	mock *attachmentMock
}

func (s attachmentSnapshot) ProjectDAO() store.ProjectReader         { return s.mock }
func (s attachmentSnapshot) TaskDAO() store.TaskReader               { return s.mock }
func (s attachmentSnapshot) AttachmentDAO() store.AttachmentReader   { return s.mock }
func (m *attachmentMock) AttachmentDAO() store.AttachmentMutationDAO { return m }
func (m *attachmentMock) ProjectAccess(ctx context.Context, p model.Principal, project string) (model.ProjectAccess, error) {
	e := m.take(ctx, "access", p, project)
	value := attachmentValue[model.ProjectAccess](m, e)
	return value, e.err
}
func (m *attachmentMock) TaskPresence(ctx context.Context, project, task string) (store.TaskPresence, error) {
	e := m.take(ctx, "presence", project, task)
	value := attachmentValue[store.TaskPresence](m, e)
	return value, e.err
}
func (m *attachmentMock) Task(ctx context.Context, project, task string) (model.Task, error) {
	e := m.take(ctx, "task", project, task)
	value := attachmentValue[model.Task](m, e)
	return value, e.err
}
func (m *attachmentMock) LockTaskPresence(ctx context.Context, project, task string) (store.TaskPresence, error) {
	e := m.take(ctx, "lock", project, task)
	value := attachmentValue[store.TaskPresence](m, e)
	return value, e.err
}
func (m *attachmentMock) ProjectAuthorization(ctx context.Context, p model.Principal, project string) (model.ProjectAccess, error) {
	e := m.take(ctx, "authorize", p, project)
	value := attachmentValue[model.ProjectAccess](m, e)
	return value, e.err
}
func (m *attachmentMock) ProjectLive(ctx context.Context, project string) error {
	return m.take(ctx, "live", project).err
}
func (m *attachmentMock) Attachment(ctx context.Context, project, task, path string) (model.Attachment, error) {
	e := m.take(ctx, "metadata", project, task, path)
	value := attachmentValue[model.Attachment](m, e)
	return value, e.err
}
func (m *attachmentMock) Attachments(ctx context.Context, project, task string, q store.AttachmentQuery) (store.AttachmentPage, error) {
	e := m.take(ctx, "list", project, task, q)
	value := attachmentValue[store.AttachmentPage](m, e)
	return value, e.err
}
func (m *attachmentMock) AttachmentPathConflict(ctx context.Context, project, task string, q store.AttachmentConflictQuery) (bool, error) {
	e := m.take(ctx, "conflict", project, task, q)
	value := attachmentValue[bool](m, e)
	return value, e.err
}

type attachmentPutResult struct {
	item    model.Attachment
	created bool
}

func (m *attachmentMock) PutAttachment(ctx context.Context, item model.Attachment) (model.Attachment, bool, error) {
	e := m.take(ctx, "put", item)
	value := attachmentValue[attachmentPutResult](m, e)
	return value.item, value.created, e.err
}
func (m *attachmentMock) DeleteAttachment(ctx context.Context, project, task, path string) error {
	return m.take(ctx, "delete", project, task, path).err
}

func (m *attachmentMock) read(p model.Principal, task model.Task) {
	m.expect("snapshot").callback = true
	m.expect("access", p, task.ProjectID).result = model.ProjectAccess{ProjectID: task.ProjectID}
	m.expect("presence", task.ProjectID, task.ID).result = store.TaskPresence{Found: true}
}
func (m *attachmentMock) mutation(task model.Task, completion store.Completion) *attachmentExpectation {
	e := m.expect("mutation")
	e.callback = true
	e.completion = completion
	m.expect("lock", task.ProjectID, task.ID).result = store.TaskPresence{Found: true}
	return e
}
func (m *attachmentMock) put(task model.Task, path, contentType string, size int64, result model.Attachment, created bool) {
	m.expect("live", task.ProjectID)
	m.conflict(task, path, false)
	m.expect("put", model.Attachment{ProjectID: task.ProjectID, TaskID: task.ID, Path: path, ContentType: contentType, SizeBytes: size}).result = attachmentPutResult{result, created}
}
func (m *attachmentMock) conflict(task model.Task, path string, value bool) *attachmentExpectation {
	address, err := attachmentcore.NewAddress(task.ProjectID, task.ID, path)
	if err != nil {
		m.t.Fatal(err)
	}
	q := store.AttachmentConflictQuery{Ancestors: []string{}, DescendantPrefix: path + "/"}
	for i, c := range address.RelativePath {
		if c == '/' {
			q.Ancestors = append(q.Ancestors, path[:i])
		}
	}
	e := m.expect("conflict", task.ProjectID, task.ID, q)
	e.result = value
	return e
}
func (m *attachmentMock) metadata(task model.Task, item model.Attachment) *attachmentExpectation {
	e := m.expect("metadata", task.ProjectID, task.ID, item.Path)
	e.result = item
	return e
}

func attachmentUnit(t *testing.T) (*Attachments, *attachmentMock, *local.Storage, model.Task, model.Principal) {
	t.Helper()
	m := newAttachmentMock(t)
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	task := model.Task{ID: "ab000000-0000-4000-8000-000000000001", ProjectID: "cd000000-0000-4000-8000-000000000001", Title: "Attachments", Version: 7}
	p := model.Principal{Kind: model.SessionCredential, UserID: "ef000000-0000-4000-8000-000000000001", CredentialID: "ef000000-0000-4000-8000-000000000002"}
	return NewAttachments(m, m, files), m, files, task, p
}
func attachmentItem(task model.Task, path, contentType string, size int64) model.Attachment {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	return model.Attachment{ProjectID: task.ProjectID, TaskID: task.ID, Path: path, ContentType: contentType, SizeBytes: size, CreatedAt: now, UpdatedAt: now}
}
func attachmentTestStoragePath(task model.Task, path string) string {
	return task.ProjectID + "/" + task.ID[:2] + "/" + task.ID + "/" + path
}
func pointer[T any](value T) *T { return &value }
func requireFault(t *testing.T, err error, code string) *model.Fault {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != code || f.Message == "" {
		t.Fatalf("expected %s fault, got %#v", code, err)
	}
	return f
}

func planAttachmentPut(m *attachmentMock, principal model.Principal, task model.Task, item model.Attachment, created bool) {
	m.read(principal, task)
	m.mutation(task, store.Completion{Outcome: store.TransactionCommitted})
	m.put(task, item.Path, item.ContentType, item.SizeBytes, item, created)
}
func planAttachmentOpen(m *attachmentMock, principal model.Principal, task model.Task, item model.Attachment) {
	m.read(principal, task)
	m.metadata(task, item)
}
func planAttachmentDelete(m *attachmentMock, principal model.Principal, task model.Task, item model.Attachment) {
	m.mutation(task, store.Completion{Outcome: store.TransactionCommitted})
	m.expect("authorize", principal, task.ProjectID).result = model.ProjectAccess{ProjectID: task.ProjectID}
	m.metadata(task, item)
	m.expect("delete", task.ProjectID, task.ID, item.Path)
}

func attachmentValue[T any](m *attachmentMock, e *attachmentExpectation) T {
	value, ok := e.result.(T)
	if !ok && e.err == nil {
		m.t.Errorf("%s requires an explicitly configured %T result, got %T", e.name, value, e.result)
	}
	return value
}
