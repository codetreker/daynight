package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestRuntimeAttachmentPathAndCursorBoundary(t *testing.T) {
	project := api.Project{ID: "c3333333-3333-4333-8333-333333333333"}
	task := api.Task{ProjectID: project.ID, ID: "d4444444-4444-4444-8444-444444444444"}
	segments := make([]string, 13)
	for i := range segments {
		segments[i] = strings.Repeat("中", 78)
	}
	segments[12] = strings.Repeat("中", 76)
	path := strings.Join(segments, "/")
	if utf8.RuneCountInString(path) != attachmentcore.MaxPathCharacters {
		t.Fatal("attachment path fixture has the wrong code-point length")
	}
	cursorJSON, err := json.Marshal(struct {
		Version   int    `json:"version"`
		Kind      string `json:"kind"`
		ProjectID string `json:"projectId"`
		TaskID    string `json:"taskId"`
		Path      string `json:"path"`
	}{Version: 1, Kind: "attachments", ProjectID: project.ID, TaskID: task.ID, Path: path})
	if err != nil {
		t.Fatal(err)
	}
	cursor := base64.RawURLEncoding.EncodeToString(cursorJSON)
	operations := configureTransportAttachments(t, project.ID, task.ID, path, cursor)
	handler := newOperationHTTPServer(t, func(deps *httpDependencies) {
		deps.Attachments = operations
	}, io.Discard, defaultHTTPPrincipal())
	addr := startBoundaryRuntime(t, handler)
	client := &http.Client{Timeout: 5 * time.Second}
	t.Cleanup(client.CloseIdleConnections)
	do := func(method, target, body string) *http.Response {
		t.Helper()
		request, err := http.NewRequest(method, "http://"+addr+target, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+handler.token)
		if method == http.MethodPut {
			request.Header.Set("Content-Type", "text/plain")
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	filePath := attachmentFilePath(task, path)
	if !strings.Contains(filePath, "%E4%B8%AD") {
		t.Fatal("attachment URL was not percent encoded")
	}
	put := do(http.MethodPut, filePath, "boundary-content")
	putBody, err := io.ReadAll(put.Body)
	_ = put.Body.Close()
	if err != nil || put.StatusCode != http.StatusCreated {
		t.Fatalf("put status=%d body=%s error=%v", put.StatusCode, putBody, err)
	}
	read := do(http.MethodGet, filePath, "")
	data, err := io.ReadAll(read.Body)
	_ = read.Body.Close()
	if err != nil || read.StatusCode != http.StatusOK || string(data) != "boundary-content" {
		t.Fatalf("read status=%d body=%q error=%v", read.StatusCode, data, err)
	}
	other := do(http.MethodPut, attachmentFilePath(task, "😀"), "next")
	otherBody, err := io.ReadAll(other.Body)
	_ = other.Body.Close()
	if err != nil || other.StatusCode != http.StatusCreated {
		t.Fatalf("second put status=%d body=%s error=%v", other.StatusCode, otherBody, err)
	}
	list := do(http.MethodGet, taskPath(task)+"/attachments?limit=1&cursor="+url.QueryEscape(cursor), "")
	var result api.AttachmentPage
	err = json.NewDecoder(list.Body).Decode(&result)
	_ = list.Body.Close()
	if err != nil || list.StatusCode != http.StatusOK || len(result.Items) != 1 || result.Items[0].Path != "😀" {
		t.Fatalf("cursor list status=%d page=%+v error=%v", list.StatusCode, result, err)
	}
}

// These operation results are independent metadata facts. Only the body and
// local file lifetime remain real in this transport boundary test.
func configureTransportAttachments(t *testing.T, projectID, taskID, path, cursor string) *transportAttachmentOperations {
	t.Helper()
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	first := model.Attachment{ProjectID: projectID, TaskID: taskID, Path: path, ContentType: "text/plain", SizeBytes: 16, CreatedAt: at, UpdatedAt: at}
	second := model.Attachment{ProjectID: projectID, TaskID: taskID, Path: "😀", ContentType: "text/plain", SizeBytes: 4, CreatedAt: at, UpdatedAt: at}
	operations := &transportAttachmentOperations{t: t, files: attachmentTestFiles(t), projectID: projectID, taskID: taskID,
		path: path, cursor: cursor, principal: defaultHTTPPrincipal(), items: [2]model.Attachment{first, second}}
	t.Cleanup(func() {
		operations.mu.Lock()
		defer operations.mu.Unlock()
		if operations.position != 4 {
			t.Errorf("attachment transport operations=%d, want four", operations.position)
		}
		if operations.leaseCloses.Load() != 2 || operations.bodyCloses.Load() != 1 {
			t.Errorf("attachment resource closes: leases=%d bodies=%d, want 2/1", operations.leaseCloses.Load(), operations.bodyCloses.Load())
		}
	})
	return operations
}

type transportAttachmentOperations struct {
	t                               *testing.T
	files                           *local.Storage
	projectID, taskID, path, cursor string
	principal                       model.Principal
	items                           [2]model.Attachment
	mu                              sync.Mutex
	position                        int
	leaseCloses                     atomic.Int32
	bodyCloses                      atomic.Int32
}

func (o *transportAttachmentOperations) enter(ctx context.Context, principal model.Principal, projectID, taskID, method string) (int, error) {
	requireOperationHTTPContext(o.t, ctx)
	o.mu.Lock()
	defer o.mu.Unlock()
	methods := [...]string{"put", "open", "put", "list"}
	index := o.position
	if index >= len(methods) || methods[index] != method || ctx.Err() != nil ||
		principal != o.principal || projectID != o.projectID || taskID != o.taskID {
		o.t.Errorf("unexpected attachment operation: method=%s position=%d principal=%+v project=%q task=%q context=%v", method, index, principal, projectID, taskID, ctx.Err())
		return 0, errors.New("unexpected attachment transport operation")
	}
	o.position++
	return index, nil
}

func (o *transportAttachmentOperations) PutRetained(ctx context.Context, principal model.Principal, projectID, taskID, path, contentType string, content io.Reader) (model.Attachment, bool, io.Closer, error) {
	index, err := o.enter(ctx, principal, projectID, taskID, "put")
	if err != nil {
		return model.Attachment{}, false, nil, err
	}
	item := o.items[0]
	expected := []byte("boundary-content")
	if index == 2 {
		item, expected = o.items[1], []byte("next")
	}
	if path != item.Path || contentType != item.ContentType {
		o.t.Errorf("attachment upload arguments: path=%q contentType=%q, want %q/%q", path, contentType, item.Path, item.ContentType)
		return model.Attachment{}, false, nil, errors.New("attachment upload arguments differ")
	}
	data, err := io.ReadAll(content)
	if err != nil {
		return model.Attachment{}, false, nil, err
	}
	if !bytes.Equal(data, expected) {
		o.t.Errorf("attachment upload bytes=%q, want %q", data, expected)
		return model.Attachment{}, false, nil, errors.New("attachment upload bytes differ")
	}
	storagePath := projectID + "/" + taskID[:2] + "/" + taskID + "/" + path
	lease, err := o.files.AcquireGate(ctx, filestorage.TargetGate, storagePath)
	if err != nil {
		return model.Attachment{}, false, nil, err
	}
	retained := &transportAttachmentCloser{Closer: lease, closes: &o.leaseCloses}
	info, err := o.files.Put(ctx, attachmentcore.Bucket, storagePath, bytes.NewReader(data))
	if err != nil {
		return model.Attachment{}, false, retained, err
	}
	if info.Size != item.SizeBytes {
		o.t.Errorf("attachment file size=%d, want %d", info.Size, item.SizeBytes)
		return model.Attachment{}, false, retained, fmt.Errorf("attachment file size differs: %d", info.Size)
	}
	return item, true, retained, nil
}

func (o *transportAttachmentOperations) Open(ctx context.Context, principal model.Principal, projectID, taskID, path string) (model.Attachment, filestorage.Object, error) {
	if _, err := o.enter(ctx, principal, projectID, taskID, "open"); err != nil {
		return model.Attachment{}, filestorage.Object{}, err
	}
	if path != o.path {
		o.t.Errorf("attachment download path=%q, want %q", path, o.path)
		return model.Attachment{}, filestorage.Object{}, errors.New("attachment download path differs")
	}
	object, err := o.files.Open(ctx, attachmentcore.Bucket, projectID+"/"+taskID[:2]+"/"+taskID+"/"+path)
	if err != nil {
		return model.Attachment{}, filestorage.Object{}, err
	}
	object.Body = &transportAttachmentBody{ReadCloser: object.Body, closes: &o.bodyCloses}
	return o.items[0], object, nil
}

func (o *transportAttachmentOperations) List(ctx context.Context, principal model.Principal, projectID, taskID string, request model.PageRequest) (attachmentcore.Page, error) {
	if _, err := o.enter(ctx, principal, projectID, taskID, "list"); err != nil {
		return attachmentcore.Page{}, err
	}
	cursor := o.cursor
	if !reflect.DeepEqual(request, model.PageRequest{Limit: 1, Cursor: &cursor}) {
		o.t.Errorf("attachment page request=%+v, want limit1 and original cursor", request)
		return attachmentcore.Page{}, errors.New("attachment page request differs")
	}
	return attachmentcore.Page{Items: []model.Attachment{o.items[1]}}, nil
}

func (o *transportAttachmentOperations) Delete(context.Context, model.Principal, string, string, string) error {
	o.t.Error("unexpected Attachments.Delete")
	return errors.New("unexpected Attachments.Delete")
}

type transportAttachmentCloser struct {
	io.Closer
	closes *atomic.Int32
}

func (c *transportAttachmentCloser) Close() error {
	c.closes.Add(1)
	return c.Closer.Close()
}

type transportAttachmentBody struct {
	io.ReadCloser
	closes *atomic.Int32
}

func (b *transportAttachmentBody) Close() error {
	b.closes.Add(1)
	return b.ReadCloser.Close()
}
