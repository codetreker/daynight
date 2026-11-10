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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
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
	t               *testing.T
	mu              sync.Mutex
	plan            []*attachmentExpectation
	scopeContext    context.Context
	scopeCapability *attachmentCapability
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
		m.scopeContext = ctx
		m.scopeCapability = &attachmentCapability{mock: m}
		defer func() { m.scopeContext = nil; m.scopeCapability = nil }()
		if err := fn(attachmentSnapshot{capability: m.scopeCapability}); err != nil {
			return err
		}
	}
	return e.err
}
func (m *attachmentMock) WriteAttachmentMutation(ctx context.Context, fn func(store.AttachmentMutationScope) error) (store.Completion, error) {
	e := m.take(ctx, "mutation")
	if e.callback {
		m.scopeContext = ctx
		m.scopeCapability = &attachmentCapability{mock: m}
		defer func() { m.scopeContext = nil; m.scopeCapability = nil }()
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
	capability *attachmentCapability
}
type attachmentCapability struct {
	store.ProjectReader
	store.TaskReader
	store.AttachmentMutationDAO
	mock *attachmentMock
}

func (c *attachmentCapability) TaskPresence(ctx context.Context, project, task string) (store.TaskPresence, error) {
	return c.mock.TaskPresence(ctx, project, task)
}
func (c *attachmentCapability) Attachments(ctx context.Context, project, task string, q store.AttachmentQuery) (store.AttachmentPage, error) {
	return c.mock.Attachments(ctx, project, task, q)
}
func (c *attachmentCapability) ProjectAccess(ctx context.Context, p model.Principal, project string) (model.ProjectAccess, error) {
	return c.mock.ProjectAccess(ctx, p, project)
}
func (c *attachmentCapability) Attachment(ctx context.Context, project, task, path string) (model.Attachment, error) {
	return c.mock.Attachment(ctx, project, task, path)
}
func (c *attachmentCapability) AttachmentPathConflict(ctx context.Context, project, task string, q store.AttachmentConflictQuery) (bool, error) {
	return c.mock.AttachmentPathConflict(ctx, project, task, q)
}
func (c *attachmentCapability) PutAttachment(ctx context.Context, item model.Attachment) (model.Attachment, bool, error) {
	return c.mock.PutAttachment(ctx, item)
}
func (c *attachmentCapability) DeleteAttachment(ctx context.Context, project, task, path string) error {
	return c.mock.DeleteAttachment(ctx, project, task, path)
}
func (s attachmentSnapshot) ProjectDAO() store.ProjectReader         { return s.capability }
func (s attachmentSnapshot) TaskDAO() store.TaskReader               { return s.capability }
func (s attachmentSnapshot) AttachmentDAO() store.AttachmentReader   { return s.capability }
func (m *attachmentMock) AttachmentDAO() store.AttachmentMutationDAO { return m.scopeCapability }
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
func (m *attachmentMock) Attachments(ctx context.Context, project, task string, q store.AttachmentQuery) (store.AttachmentPage, error) {
	e := m.take(ctx, "list", project, task, q)
	value := attachmentValue[store.AttachmentPage](m, e)
	return value, e.err
}

type attachmentPutResult struct {
	item    model.Attachment
	created bool
}

func (m *attachmentMock) unexpectedDAO(name string) error {
	m.t.Helper()
	m.t.Errorf("unexpected lower business DAO call %s", name)
	return errors.New("unexpected lower business DAO call: " + name)
}
func (m *attachmentMock) ProjectAccess(context.Context, model.Principal, string) (model.ProjectAccess, error) {
	return model.ProjectAccess{}, m.unexpectedDAO("ProjectAccess")
}
func (m *attachmentMock) Attachment(context.Context, string, string, string) (model.Attachment, error) {
	return model.Attachment{}, m.unexpectedDAO("Attachment")
}
func (m *attachmentMock) AttachmentPathConflict(context.Context, string, string, store.AttachmentConflictQuery) (bool, error) {
	return false, m.unexpectedDAO("AttachmentPathConflict")
}
func (m *attachmentMock) PutAttachment(context.Context, model.Attachment) (model.Attachment, bool, error) {
	return model.Attachment{}, false, m.unexpectedDAO("PutAttachment")
}
func (m *attachmentMock) DeleteAttachment(context.Context, string, string, string) error {
	return m.unexpectedDAO("DeleteAttachment")
}
func (m *attachmentMock) address(address attachmentcore.Address) {
	m.t.Helper()
	if address.StoragePath != attachmentTestStoragePath(model.Task{ProjectID: address.ProjectID, ID: address.TaskID}, address.RelativePath) {
		m.t.Error("operation address lost storage path")
	}
}
func (m *attachmentMock) capability(ctx context.Context, capability any) {
	m.t.Helper()
	if capability != m.scopeCapability {
		m.t.Errorf("operation received another scope capability: %T", capability)
	}
	if ctx != m.scopeContext {
		m.t.Error("operation received another scope context")
	}
}
func (m *attachmentMock) service(mutations store.AttachmentMutationWriter, files filestorage.Storage) *Attachments {
	s := NewAttachments(m, mutations, files)
	s.operations = attachmentOperations{
		requireProjectRead: func(ctx context.Context, reader projectcore.ProjectAccessReader, principal model.Principal, project string) (model.ProjectAccess, error) {
			m.capability(ctx, reader)
			e := m.take(ctx, "projectRead", principal, project)
			return attachmentValue[model.ProjectAccess](m, e), e.err
		},
		checkPathConflict: func(ctx context.Context, reader store.AttachmentReader, address attachmentcore.Address) error {
			m.capability(ctx, reader)
			m.address(address)
			return m.take(ctx, "pathConflict", address).err
		},
		metadata: func(ctx context.Context, reader store.AttachmentReader, address attachmentcore.Address) (model.Attachment, error) {
			m.capability(ctx, reader)
			m.address(address)
			e := m.take(ctx, "metadataRead", address.ProjectID, address.TaskID, address.RelativePath)
			return attachmentValue[model.Attachment](m, e), e.err
		},
		putMetadata: func(ctx context.Context, writer store.AttachmentWriter, address attachmentcore.Address, contentType string, size int64) (model.Attachment, bool, error) {
			m.capability(ctx, writer)
			m.address(address)
			e := m.take(ctx, "metadataPut", model.Attachment{ProjectID: address.ProjectID, TaskID: address.TaskID, Path: address.RelativePath, ContentType: contentType, SizeBytes: size})
			value := attachmentValue[attachmentPutResult](m, e)
			return value.item, value.created, e.err
		},
		deleteMetadata: func(ctx context.Context, writer store.AttachmentWriter, address attachmentcore.Address) error {
			m.capability(ctx, writer)
			m.address(address)
			return m.take(ctx, "metadataDelete", address.ProjectID, address.TaskID, address.RelativePath).err
		},
	}
	return s
}
func projectReadNotFound() error { return projectcore.ProjectNotFound(model.ErrNotFound) }

func attachmentNotFound() error {
	return attachmentcore.NotFound(model.ErrNotFound)
}

func (m *attachmentMock) read(p model.Principal, task model.Task) {
	m.expect("snapshot").callback = true
	m.expect("projectRead", p, task.ProjectID).result = model.ProjectAccess{ProjectID: task.ProjectID}
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
	m.expect("metadataPut", model.Attachment{ProjectID: task.ProjectID, TaskID: task.ID, Path: path, ContentType: contentType, SizeBytes: size}).result = attachmentPutResult{result, created}
}
func (m *attachmentMock) conflict(task model.Task, path string, value bool) *attachmentExpectation {
	address := attachmentcore.Address{ProjectID: task.ProjectID, TaskID: task.ID, RelativePath: path, StoragePath: attachmentTestStoragePath(task, path)}
	e := m.expect("pathConflict", address)
	if value {
		e.err = &model.Fault{Code: "path_conflict", Message: "Attachment path conflicts with a file or directory."}
	}
	return e
}
func (m *attachmentMock) metadata(task model.Task, item model.Attachment) *attachmentExpectation {
	e := m.expect("metadataRead", task.ProjectID, task.ID, item.Path)
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
	return m.service(m, files), m, files, task, p
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
	m.expect("metadataDelete", task.ProjectID, task.ID, item.Path)
}

func attachmentValue[T any](m *attachmentMock, e *attachmentExpectation) T {
	value, ok := e.result.(T)
	if !ok && e.err == nil {
		m.t.Errorf("%s requires an explicitly configured %T result, got %T", e.name, value, e.result)
	}
	return value
}
