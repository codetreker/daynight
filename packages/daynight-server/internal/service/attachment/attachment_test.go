package attachment

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestAttachmentValidation(t *testing.T) {
	principal := model.Principal{Kind: model.SessionCredential,
		UserID: "00000000-0000-4000-8000-000000000001", CredentialID: "00000000-0000-4000-8000-000000000002"}
	attachments := NewAttachments(nil, nil, nil)
	id := "00000000-0000-0000-0000-000000000001"
	for _, address := range [][3]string{{"invalid", id, "file"}, {id, "invalid", "file"}, {id, id, ""}, {id, id, "/file"},
		{id, id, "a//b"}, {id, id, "a/../b"}, {id, id, "a/./b"}, {id, id, "a\\b"}, {id, id, "a\x00b"}, {id, id, "\xff"}, {id, id, "C:/file"}} {
		_, _, err := attachments.Put(context.Background(), principal, address[0], address[1], address[2], "text/plain", strings.NewReader(""))
		requireFault(t, err, "invalid_input")
		_, _, err = attachments.Open(context.Background(), principal, address[0], address[1], address[2])
		requireFault(t, err, "invalid_input")
		requireFault(t, attachments.Delete(context.Background(), principal, address[0], address[1], address[2]), "invalid_input")
	}
	for _, contentType := range []string{"", "broken", "text/plain; charset", "text/plain\r\nInjected: yes"} {
		_, _, err := attachments.Put(context.Background(), principal, id, id, "file", contentType, strings.NewReader(""))
		requireFault(t, err, "invalid_input")
	}
	for _, scope := range [][2]string{{"bad", id}, {id, "bad"}} {
		_, err := attachments.List(context.Background(), principal, scope[0], scope[1], model.PageRequest{Limit: 1})
		requireFault(t, err, "invalid_input")
	}
}

type attachmentFaultStorage struct {
	filestorage.Storage
	put         error
	open        error
	delete      error
	afterPut    func()
	afterDelete func()
}

func (s attachmentFaultStorage) Put(ctx context.Context, bucket, path string, content io.Reader) (filestorage.FileInfo, error) {
	if s.put != nil {
		return filestorage.FileInfo{}, s.put
	}
	info, err := s.Storage.Put(ctx, bucket, path, content)
	if err == nil && s.afterPut != nil {
		s.afterPut()
	}
	return info, err
}

func (s attachmentFaultStorage) Open(ctx context.Context, bucket, path string) (filestorage.Object, error) {
	if s.open != nil {
		return filestorage.Object{}, s.open
	}
	return s.Storage.Open(ctx, bucket, path)
}

func (s attachmentFaultStorage) Delete(ctx context.Context, bucket, path string) error {
	if s.delete != nil {
		return s.delete
	}
	err := s.Storage.Delete(ctx, bucket, path)
	if err == nil && s.afterDelete != nil {
		s.afterDelete()
	}
	return err
}

func assertAttachmentOperationalError(t *testing.T, err, cause error) {
	t.Helper()
	var fault *model.Fault
	if !errors.Is(err, cause) || errors.As(err, &fault) {
		t.Fatalf("operational error lost cause or became business fault: %v", err)
	}
}

// Cursor fields mirror the public v1 wire format for invalid-input tests.
type testAttachmentCursor struct {
	Version   int    `json:"version"`
	Kind      string `json:"kind"`
	ProjectID string `json:"projectId"`
	TaskID    string `json:"taskId"`
	Path      string `json:"path"`
}

func TestAttachmentLifecycleAndTaskIndependence(t *testing.T) {
	subject, m, files, task, p := attachmentUnit(t)
	ctx := t.Context()
	m.read(p, task)
	m.expect("list", task.ProjectID, task.ID, store.AttachmentQuery{Limit: 50}).result = store.AttachmentPage{Items: []model.Attachment{}}
	empty, err := subject.List(ctx, p, task.ProjectID, task.ID, model.PageRequest{Limit: 50})
	if err != nil || empty.Items == nil || len(empty.Items) != 0 || empty.NextCursor != nil {
		t.Fatalf("empty page: %#v %v", empty, err)
	}
	content := []byte{0, 1, 255, '\n', 'a'}
	first := attachmentItem(task, "设计 文档/a%_?#.bin", "application/octet-stream", int64(len(content)))
	planAttachmentPut(m, p, task, first, true)
	got, created, err := subject.Put(ctx, p, strings.ToUpper(task.ProjectID), strings.ToUpper(task.ID), first.Path, first.ContentType, bytes.NewReader(content))
	if err != nil || !created || !reflect.DeepEqual(got, first) {
		t.Fatalf("new attachment: %#v %v %v", got, created, err)
	}
	planAttachmentOpen(m, p, task, first)
	metadata, object, err := subject.Open(ctx, p, task.ProjectID, task.ID, first.Path)
	if err != nil {
		t.Fatal(err)
	}
	data, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || !bytes.Equal(data, content) || object.Info.Size != first.SizeBytes || !reflect.DeepEqual(metadata, first) {
		t.Fatalf("binary read: %#v %q %v %v", metadata, data, readErr, closeErr)
	}
	second := first
	second.ContentType = "text/plain; charset=utf-8"
	second.SizeBytes = 11
	second.UpdatedAt = second.UpdatedAt.Add(time.Second)
	planAttachmentPut(m, p, task, second, false)
	got, created, err = subject.Put(ctx, p, task.ProjectID, task.ID, second.Path, second.ContentType, strings.NewReader("replacement"))
	if err != nil || created || !reflect.DeepEqual(got, second) {
		t.Fatalf("overwrite result: %#v %v %v", got, created, err)
	}
	for _, item := range []model.Attachment{attachmentItem(task, "other/a%_?#.bin", "text/plain", 5), attachmentItem(task, "empty", "text/plain", 0)} {
		planAttachmentPut(m, p, task, item, true)
		text := "other"
		if item.SizeBytes == 0 {
			text = ""
		}
		got, created, err := subject.Put(ctx, p, task.ProjectID, task.ID, item.Path, item.ContentType, strings.NewReader(text))
		if err != nil || !created || !reflect.DeepEqual(got, item) {
			t.Fatalf("extra item: %#v %v %v", got, created, err)
		}
	}
	if _, err := files.Put(ctx, attachmentcore.Bucket, attachmentTestStoragePath(task, first.Path), strings.NewReader("different physical length")); err != nil {
		t.Fatal(err)
	}
	planAttachmentOpen(m, p, task, second)
	metadata, object, err = subject.Open(ctx, p, task.ProjectID, task.ID, second.Path)
	if err != nil || object.Info.Size != 25 || metadata.SizeBytes != 11 {
		t.Fatalf("actual length: %#v %#v %v", metadata, object.Info, err)
	}
	if err := object.Body.Close(); err != nil {
		t.Fatal(err)
	}
	planAttachmentDelete(m, p, task, second)
	if err := subject.Delete(ctx, p, task.ProjectID, task.ID, second.Path); err != nil {
		t.Fatal(err)
	}
	m.read(p, task)
	m.expect("metadata", task.ProjectID, task.ID, second.Path).err = model.ErrNotFound
	_, _, err = subject.Open(ctx, p, task.ProjectID, task.ID, second.Path)
	requireFault(t, err, "not_found")
	m.mutation(task, store.Completion{Outcome: store.TransactionNotCommitted})
	m.expect("authorize", p, task.ProjectID).result = model.ProjectAccess{}
	m.expect("metadata", task.ProjectID, task.ID, second.Path).err = model.ErrNotFound
	requireFault(t, subject.Delete(ctx, p, task.ProjectID, task.ID, second.Path), "not_found")
	rebuilt := first
	rebuilt.CreatedAt = first.CreatedAt.Add(2 * time.Second)
	rebuilt.UpdatedAt = rebuilt.CreatedAt
	rebuilt.SizeBytes = 7
	rebuilt.ContentType = "text/plain"
	planAttachmentPut(m, p, task, rebuilt, true)
	got, created, err = subject.Put(ctx, p, task.ProjectID, task.ID, rebuilt.Path, rebuilt.ContentType, strings.NewReader("rebuilt"))
	if err != nil || !created || !reflect.DeepEqual(got, rebuilt) {
		t.Fatalf("rebuilt: %#v %v %v", got, created, err)
	}
}

func TestAttachmentScopeAndPathConflicts(t *testing.T) {
	subject, m, _, task, p := attachmentUnit(t)
	for _, path := range []string{"docs/child", "literal%_"} {
		m.read(p, task)
		m.mutation(task, store.Completion{Outcome: store.TransactionNotCommitted})
		m.expect("live", task.ProjectID)
		m.conflict(task, path, true)
		_, _, err := subject.Put(t.Context(), p, task.ProjectID, task.ID, path, "text/plain", strings.NewReader("conflict"))
		requireFault(t, err, "path_conflict")
	}
	missing := "00000000-0000-0000-0000-000000000000"
	other := task
	other.ID = "ab000000-0000-4000-8000-000000000002"
	other.ProjectID = "cd000000-0000-4000-8000-000000000002"
	for _, ids := range [][2]string{{missing, task.ID}, {task.ProjectID, missing}, {task.ProjectID, other.ID}, {other.ProjectID, task.ID}} {
		addressed := task
		addressed.ProjectID, addressed.ID = ids[0], ids[1]
		readMissing := func() {
			m.expect("snapshot").callback = true
			m.expect("access", p, addressed.ProjectID).result = model.ProjectAccess{}
			m.expect("presence", addressed.ProjectID, addressed.ID).result = store.TaskPresence{Found: false}
		}
		mutateMissing := func() {
			e := m.expect("mutation")
			e.callback = true
			e.completion = store.Completion{Outcome: store.TransactionNotCommitted}
			m.expect("lock", addressed.ProjectID, addressed.ID).result = store.TaskPresence{Found: false}
			m.expect("authorize", p, addressed.ProjectID).result = model.ProjectAccess{}
		}
		readMissing()
		_, err := subject.List(t.Context(), p, ids[0], ids[1], model.PageRequest{Limit: 10})
		requireFault(t, err, "not_found")
		readMissing()
		mutateMissing()
		_, _, err = subject.Put(t.Context(), p, ids[0], ids[1], "file", "text/plain", strings.NewReader("no"))
		requireFault(t, err, "not_found")
		readMissing()
		_, _, err = subject.Open(t.Context(), p, ids[0], ids[1], "docs")
		requireFault(t, err, "not_found")
		mutateMissing()
		requireFault(t, subject.Delete(t.Context(), p, ids[0], ids[1], "docs"), "not_found")
	}
	m.read(p, task)
	m.expect("metadata", task.ProjectID, task.ID, "missing").err = model.ErrNotFound
	_, _, err := subject.Open(t.Context(), p, task.ProjectID, task.ID, "missing")
	requireFault(t, err, "not_found")
}

func TestAttachmentPaginationAndCursorScope(t *testing.T) {
	subject, m, _, task, p := attachmentUnit(t)
	want := []string{"a/file", "A/file", "中 文", "emoji-😀", "%literal", "_literal"}
	slices.Sort(want)
	request := model.PageRequest{Limit: 2}
	var got []string
	var firstCursor *string
	for i := 0; i < len(want); i += 2 {
		q := store.AttachmentQuery{Limit: 2}
		if i > 0 {
			q.After = pointer(want[i-1])
		}
		items := []model.Attachment{attachmentItem(task, want[i], "text/plain", 1), attachmentItem(task, want[i+1], "text/plain", 2)}
		m.read(p, task)
		m.expect("list", task.ProjectID, task.ID, q).result = store.AttachmentPage{Items: items, HasMore: i+2 < len(want)}
		page, err := subject.List(t.Context(), p, strings.ToUpper(task.ProjectID), strings.ToUpper(task.ID), request)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(page.Items, items) {
			t.Fatalf("page projection: %#v", page)
		}
		for _, item := range page.Items {
			got = append(got, item.Path)
		}
		if page.NextCursor == nil {
			break
		}
		if firstCursor == nil {
			firstCursor = page.NextCursor
		}
		request.Cursor = page.NextCursor
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("page paths: %v", got)
	}
	data, err := base64.RawURLEncoding.DecodeString(*firstCursor)
	if err != nil {
		t.Fatal(err)
	}
	var valid testAttachmentCursor
	if err := json.Unmarshal(data, &valid); err != nil {
		t.Fatal(err)
	}
	invalid := []string{"", "not-base64", base64.RawURLEncoding.EncodeToString([]byte("{")), base64.RawURLEncoding.EncodeToString(append(data, []byte(" true")...)), base64.RawURLEncoding.EncodeToString([]byte(strings.Replace(string(data), `"version":1`, `"unknown":1,"version":1`, 1)))}
	for _, change := range []func(*testAttachmentCursor){func(c *testAttachmentCursor) { c.Version = 2 }, func(c *testAttachmentCursor) { c.Kind = "tasks" }, func(c *testAttachmentCursor) { c.ProjectID = "cd000000-0000-4000-8000-000000000002" }, func(c *testAttachmentCursor) { c.TaskID = "ab000000-0000-4000-8000-000000000002" }, func(c *testAttachmentCursor) { c.Path = "../bad" }} {
		cursor := valid
		change(&cursor)
		data, err := json.Marshal(cursor)
		if err != nil {
			t.Fatal(err)
		}
		invalid = append(invalid, base64.RawURLEncoding.EncodeToString(data))
	}
	for _, cursor := range invalid {
		_, err := subject.List(t.Context(), p, task.ProjectID, task.ID, model.PageRequest{Limit: 2, Cursor: &cursor})
		requireFault(t, err, "invalid_input")
	}
	for _, limit := range []int{0, -1, 101} {
		_, err := subject.List(t.Context(), p, task.ProjectID, task.ID, model.PageRequest{Limit: limit})
		requireFault(t, err, "invalid_input")
	}
}

func TestAttachmentStorageFailuresAndMissingPhysicalFile(t *testing.T) {
	subject, m, files, task, p := attachmentUnit(t)
	item := attachmentItem(task, "file", "text/plain", 7)
	if _, err := files.Put(t.Context(), attachmentcore.Bucket, attachmentTestStoragePath(task, item.Path), strings.NewReader("content")); err != nil {
		t.Fatal(err)
	}
	sentinel := errors.New("disk failed")
	failed := NewAttachments(m, m, attachmentFaultStorage{Storage: files, put: sentinel, open: sentinel, delete: sentinel})
	m.read(p, task)
	m.mutation(task, store.Completion{Outcome: store.TransactionNotCommitted})
	m.expect("live", task.ProjectID)
	m.conflict(task, "file", false)
	_, _, err := failed.Put(t.Context(), p, task.ProjectID, task.ID, "file", "text/plain", strings.NewReader("new"))
	assertAttachmentOperationalError(t, err, sentinel)
	planAttachmentOpen(m, p, task, item)
	_, _, err = failed.Open(t.Context(), p, task.ProjectID, task.ID, "file")
	assertAttachmentOperationalError(t, err, sentinel)
	m.mutation(task, store.Completion{Outcome: store.TransactionNotCommitted})
	m.expect("authorize", p, task.ProjectID).result = model.ProjectAccess{}
	m.metadata(task, item)
	assertAttachmentOperationalError(t, failed.Delete(t.Context(), p, task.ProjectID, task.ID, "file"), sentinel)
	if err := files.Delete(t.Context(), attachmentcore.Bucket, attachmentTestStoragePath(task, "file")); err != nil {
		t.Fatal(err)
	}
	planAttachmentOpen(m, p, task, item)
	_, _, err = subject.Open(t.Context(), p, task.ProjectID, task.ID, "file")
	assertAttachmentOperationalError(t, err, fs.ErrNotExist)
	planAttachmentDelete(m, p, task, item)
	if err := subject.Delete(t.Context(), p, task.ProjectID, task.ID, "file"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	e := m.expect("snapshot")
	e.err = context.Canceled
	e.ctx = ctx
	_, _, err = subject.Put(ctx, p, task.ProjectID, task.ID, "cancelled", "text/plain", strings.NewReader(""))
	assertAttachmentOperationalError(t, err, context.Canceled)
}

func TestAttachmentDatabaseFailures(t *testing.T) {
	subject, m, _, task, p := attachmentUnit(t)
	cause := errors.New("query failed")
	failure := &store.Error{Phase: "attachment fixture", Cause: cause}
	m.read(p, task)
	m.expect("list", task.ProjectID, task.ID, store.AttachmentQuery{Limit: 1}).err = failure
	_, err := subject.List(t.Context(), p, task.ProjectID, task.ID, model.PageRequest{Limit: 1})
	assertAttachmentDatabaseError(t, err, cause)
	m.read(p, task)
	m.expect("metadata", task.ProjectID, task.ID, "file").err = failure
	_, _, err = subject.Open(t.Context(), p, task.ProjectID, task.ID, "file")
	assertAttachmentDatabaseError(t, err, cause)
	m.read(p, task)
	m.mutation(task, store.Completion{Outcome: store.TransactionNotCommitted})
	m.expect("live", task.ProjectID)
	m.conflict(task, "new", false).err = failure
	_, _, err = subject.Put(t.Context(), p, task.ProjectID, task.ID, "new", "text/plain", strings.NewReader(""))
	assertAttachmentDatabaseError(t, err, cause)
	m.mutation(task, store.Completion{Outcome: store.TransactionNotCommitted})
	m.expect("authorize", p, task.ProjectID).result = model.ProjectAccess{}
	m.expect("metadata", task.ProjectID, task.ID, "file").err = failure
	assertAttachmentDatabaseError(t, subject.Delete(t.Context(), p, task.ProjectID, task.ID, "file"), cause)
	m.expect("snapshot").err = failure
	_, err = subject.List(t.Context(), p, task.ProjectID, task.ID, model.PageRequest{Limit: 1})
	assertAttachmentDatabaseError(t, err, cause)
}

func TestAttachmentMetadataFailuresAfterStorageOperation(t *testing.T) {
	for _, operation := range []string{"put", "delete", "suppressed delete"} {
		t.Run(operation, func(t *testing.T) {
			subject, m, files, task, p := attachmentUnit(t)
			before := attachmentItem(task, "file", "text/plain; charset=utf-8", 6)
			if _, err := files.Put(t.Context(), attachmentcore.Bucket, attachmentTestStoragePath(task, "file"), strings.NewReader("before")); err != nil {
				t.Fatal(err)
			}
			cause := errors.New("metadata failed")
			wrap := func(err error) error {
				return &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
			}
			if operation == "put" {
				m.read(p, task)
				e := m.expect("mutation")
				e.callback = true
				e.completion = store.Completion{Outcome: store.TransactionNotCommitted}
				e.callbackError = wrap
				m.expect("lock", task.ProjectID, task.ID).result = store.TaskPresence{Found: true}
				m.expect("live", task.ProjectID)
				m.conflict(task, "file", false)
				m.expect("put", model.Attachment{ProjectID: task.ProjectID, TaskID: task.ID, Path: "file", ContentType: "text/plain", SizeBytes: 5}).err = &store.Error{Phase: "put", Cause: cause}
				item, created, err := subject.Put(t.Context(), p, task.ProjectID, task.ID, "file", "text/plain", strings.NewReader("after"))
				var transaction *store.TransactionError
				var database *store.Error
				if item.Path != "" || created || !FileEffectPossible(err) || !errors.Is(err, cause) || !errors.As(err, &database) || !errors.As(err, &transaction) || transaction.Outcome != store.TransactionNotCommitted || transaction.CommitAttempted {
					t.Fatalf("put metadata failure: %#v %v %v", item, created, err)
				}
				object, err := files.Open(t.Context(), attachmentcore.Bucket, attachmentTestStoragePath(task, "file"))
				if err != nil {
					t.Fatal(err)
				}
				data, readErr := io.ReadAll(object.Body)
				closeErr := object.Body.Close()
				if readErr != nil || closeErr != nil || string(data) != "after" {
					t.Fatalf("physical result: %q %v %v", data, readErr, closeErr)
				}
			} else {
				e := m.expect("mutation")
				e.callback = true
				e.completion = store.Completion{Outcome: store.TransactionNotCommitted}
				e.callbackError = wrap
				m.expect("lock", task.ProjectID, task.ID).result = store.TaskPresence{Found: true}
				m.expect("authorize", p, task.ProjectID).result = model.ProjectAccess{}
				m.metadata(task, before)
				deletion := m.expect("delete", task.ProjectID, task.ID, "file")
				if operation == "suppressed delete" {
					deletion.err = model.ErrNotFound
				} else {
					deletion.err = &store.Error{Phase: "delete", Cause: cause}
				}
				err := subject.Delete(t.Context(), p, task.ProjectID, task.ID, "file")
				if operation == "suppressed delete" {
					requireFault(t, err, "not_found")
				} else {
					var transaction *store.TransactionError
					var database *store.Error
					if !errors.Is(err, cause) || !errors.As(err, &database) || !errors.As(err, &transaction) || transaction.Outcome != store.TransactionNotCommitted || transaction.CommitAttempted {
						t.Fatalf("delete metadata failure: %v", err)
					}
				}
				if !FileEffectPossible(err) {
					t.Fatal("file deletion fact lost")
				}
				_, err = files.Open(t.Context(), attachmentcore.Bucket, attachmentTestStoragePath(task, "file"))
				if !errors.Is(err, fs.ErrNotExist) {
					t.Fatalf("file deletion hidden: %v", err)
				}
			}
		})
	}
}

func assertAttachmentDatabaseError(t *testing.T, err, cause error) {
	t.Helper()
	assertAttachmentOperationalError(t, err, cause)
	var database *store.Error
	if !errors.As(err, &database) {
		t.Fatalf("database error type lost: %v", err)
	}
}
