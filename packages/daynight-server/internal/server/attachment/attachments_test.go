package attachment_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func attachmentTestFiles(t *testing.T) *local.Storage {
	t.Helper()
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	return files
}

func attachmentRequest(handler http.Handler, method, target, contentType string, content []byte) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, bytes.NewReader(content))
	authorizeResourceRequest(handler, request)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func attachmentFilePath(task api.Task, file string) string {
	segments := strings.Split(file, "/")
	for index, segment := range segments {
		segments[index] = url.PathEscape(segment)
	}
	return taskPath(task) + "/attachments/files/" + strings.Join(segments, "/")
}

func TestAttachmentHTTPFileLifecycleAndActualContent(t *testing.T) {
	files := attachmentTestFiles(t)
	var logs bytes.Buffer
	f := newAttachmentFixture(t, files, &logs)
	handler, task := f.handler, f.task
	file := "文档 space/设计 ?# %2F.bin"
	location := attachmentFilePath(task, file)
	payload := append(bytes.Repeat([]byte{0, 255, 128, 13, 10}, httpx.MaxJSONBody/5+1), 'x')
	metadata := f.item(task, file, "application/octet-stream", int64(len(payload)))
	f.expectPut(task, file, "application/octet-stream", int64(len(payload)), metadata, true)
	created := decodeResponse[api.Attachment](t, attachmentRequest(handler, http.MethodPut, location, "application/octet-stream", payload), http.StatusCreated)
	f.verify()
	if created.Path != file || created.SizeBytes != int64(len(payload)) || created.ContentType != "application/octet-stream" || created.CreatedAt.IsZero() || !created.CreatedAt.Equal(created.UpdatedAt) {
		t.Fatalf("created attachment: %+v", created)
	}
	for _, mode := range []string{"download", "preview"} {
		target := location
		if mode == "preview" {
			target = strings.Replace(location, "/attachments/files/", "/preview/", 1)
		}
		f.expectRead(task, file, metadata, nil)
		response := attachmentRequest(handler, http.MethodGet, target, "", nil)
		f.verify()
		mediaType, parameters, err := mime.ParseMediaType(response.Header().Get("Content-Disposition"))
		wanted := "attachment"
		if mode == "preview" {
			wanted = "inline"
		}
		if err != nil || mediaType != wanted || parameters["filename"] != "设计 ?# %2F.bin" || response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), payload) || response.Header().Get("Content-Type") != "application/octet-stream" || response.Header().Get("Content-Length") != strconv.Itoa(len(payload)) || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s content headers/status/body: %d %+v %v", mode, response.Code, response.Header(), err)
		}
	}
	replacement := metadata
	replacement.SizeBytes, replacement.ContentType = 3, "text/plain; charset=utf-8"
	replacement.UpdatedAt = replacement.UpdatedAt.Add(time.Second)
	f.expectPut(task, file, replacement.ContentType, 3, replacement, false)
	replaced := decodeResponse[api.Attachment](t, attachmentRequest(handler, http.MethodPut, location, "text/plain; charset=utf-8", []byte("new")), http.StatusOK)
	f.verify()
	if replaced.Path != file || replaced.SizeBytes != 3 || replaced.ContentType != "text/plain; charset=utf-8" || !replaced.CreatedAt.Equal(created.CreatedAt) || !replaced.UpdatedAt.After(created.UpdatedAt) {
		t.Fatalf("overwritten attachment: %+v", replaced)
	}
	if _, err := files.Put(context.Background(), "task-attachments", task.ProjectID+"/"+task.ID[:2]+"/"+task.ID+"/"+file, strings.NewReader("actual opened bytes")); err != nil {
		t.Fatal(err)
	}
	f.expectRead(task, file, replacement, nil)
	response := attachmentRequest(handler, http.MethodGet, location, "", nil)
	f.verify()
	if response.Header().Get("Content-Length") != "19" || response.Body.String() != "actual opened bytes" {
		t.Fatalf("response used stale metadata size: %+v %s", response.Header(), response.Body)
	}
	f.expectRead(task, file, replacement, nil)
	head := attachmentRequest(handler, http.MethodHead, location, "", nil)
	f.verify()
	if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("Content-Length") != "19" {
		t.Fatalf("HEAD response: %d %+v %s", head.Code, head.Header(), head.Body)
	}
	f.expectDelete(task, replacement)
	removed := attachmentRequest(handler, http.MethodDelete, location, "", nil)
	f.verify()
	if removed.Code != http.StatusNoContent || removed.Body.Len() != 0 {
		t.Fatalf("delete: %d %s", removed.Code, removed.Body)
	}
	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		if method == http.MethodGet {
			f.expectRead(task, file, replacement, model.ErrNotFound)
		} else {
			f.expectDeleteMissing(task, file)
		}
		assertProjectError(t, attachmentRequest(handler, method, location, "", nil), http.StatusNotFound, "not_found")
		f.verify()
	}
	if !strings.Contains(logs.String(), `"path":"`+file+`"`) || !strings.Contains(logs.String(), `"task_id":"`+task.ID+`"`) || !strings.Contains(logs.String(), `"route":"PUT /api/v1/projects/{projectId}/tasks/{taskId}/attachments/files/{path...}"`) {
		t.Fatalf("missing attachment context: %s", &logs)
	}
}

func TestAttachmentHTTPListsAndNestedPreview(t *testing.T) {
	f := newAttachmentFixture(t, attachmentTestFiles(t), io.Discard)
	handler, task := f.handler, f.task
	other := task
	other.ID = "00000000-0000-4000-8000-000000000098"
	collection := taskPath(task) + "/attachments"
	f.expectList(task, store.AttachmentQuery{Limit: 50}, store.AttachmentPage{}, nil)
	emptyResponse := attachmentRequest(handler, http.MethodGet, collection, "", nil)
	empty := decodeResponse[api.AttachmentPage](t, emptyResponse, http.StatusOK)
	f.verify()
	if empty.Items == nil || len(empty.Items) != 0 || empty.NextCursor != nil || emptyResponse.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("empty list: %+v", empty)
	}
	assets := []struct{ path, mime, body string }{
		{"mockup/assets/app.js", "text/javascript", `fetch('../data.json').then(x => x.json())`},
		{"mockup/assets/style.css", "text/css", "body { color: red; }"},
		{"mockup/data.json", "application/json", `{"value":1}`},
		{"mockup/index.html", "text/html", `<link rel="stylesheet" href="./assets/style.css"><script type="module" src="./assets/app.js"></script>`},
	}
	items := make([]model.Attachment, 0, len(assets))
	for _, asset := range assets {
		item := f.item(task, asset.path, asset.mime, int64(len(asset.body)))
		items = append(items, item)
		f.expectPut(task, asset.path, asset.mime, int64(len(asset.body)), item, true)
		decodeResponse[api.Attachment](t, attachmentRequest(handler, http.MethodPut, attachmentFilePath(task, asset.path), asset.mime, []byte(asset.body)), http.StatusCreated)
		f.verify()
		preview := strings.Replace(attachmentFilePath(task, asset.path), "/attachments/files/", "/preview/", 1)
		f.expectRead(task, asset.path, item, nil)
		response := attachmentRequest(handler, http.MethodGet, preview+"?v=1", "", nil)
		f.verify()
		if response.Code != http.StatusOK || response.Body.String() != asset.body || response.Header().Get("Content-Type") != asset.mime || !strings.HasPrefix(response.Header().Get("Content-Disposition"), "inline") {
			t.Fatalf("relative preview resource %s: %d %s", asset.path, response.Code, response.Body)
		}
	}
	f.expectList(task, store.AttachmentQuery{Limit: 2}, store.AttachmentPage{Items: items[:2], HasMore: true}, nil)
	first := decodeResponse[api.AttachmentPage](t, attachmentRequest(handler, http.MethodGet, collection+"?limit=2", "", nil), http.StatusOK)
	f.verify()
	if len(first.Items) != 2 || first.Items[0].Path != assets[0].path || first.Items[1].Path != assets[1].path || first.NextCursor == nil {
		t.Fatalf("first page: %+v", first)
	}
	cursor := url.QueryEscape(*first.NextCursor)
	after := assets[1].path
	f.expectList(task, store.AttachmentQuery{Limit: 2, After: &after}, store.AttachmentPage{Items: items[2:]}, nil)
	last := decodeResponse[api.AttachmentPage](t, attachmentRequest(handler, http.MethodGet, collection+"?limit=2&cursor="+cursor, "", nil), http.StatusOK)
	f.verify()
	if len(last.Items) != 2 || last.Items[0].Path != assets[2].path || last.Items[1].Path != assets[3].path || last.NextCursor != nil {
		t.Fatalf("last page: %+v", last)
	}
	for _, target := range []string{taskPath(other) + "/attachments?cursor=" + cursor, collection + "?unknown=1", collection + "?limit=0", collection + "?cursor=bad"} {
		assertProjectError(t, attachmentRequest(handler, http.MethodGet, target, "", nil), http.StatusBadRequest, "invalid_input")
	}
	for target, allowed := range map[string]string{collection: "GET, HEAD", attachmentFilePath(task, "mockup/index.html"): "GET, HEAD, PUT, DELETE", taskPath(task) + "/preview/mockup/index.html": "GET, HEAD"} {
		response := attachmentRequest(handler, http.MethodPost, target, "", nil)
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if response.Header().Get("Allow") != allowed || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("method headers: %+v", response.Header())
		}
	}
}

func TestAttachmentHTTPRejectsOriginalPathsBeforeRedirect(t *testing.T) {
	f := newAttachmentFixture(t, attachmentTestFiles(t), io.Discard)
	handler, task := f.handler, f.task
	base := taskPath(task) + "/attachments/files/"
	item := f.item(task, "keep", "text/plain", 9)
	f.expectPut(task, "keep", "text/plain", 9, item, true)
	decodeResponse[api.Attachment](t, attachmentRequest(handler, http.MethodPut, base+"keep", "text/plain", []byte("unchanged")), http.StatusCreated)
	f.verify()
	for _, suffix := range []string{"", ".", "..", "a/../keep", "./keep", "a//keep", "a/", "%2e%2e/keep", "a%2fkeep", "a%2Fkeep", "%5ckeep", "a%00b", "%ff", "C:/keep", "../../../.."} {
		for _, method := range []string{http.MethodPut, http.MethodDelete, http.MethodGet} {
			response := attachmentRequest(handler, method, base+suffix, "text/plain", []byte("mutated"))
			assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
			if response.Header().Get("Location") != "" {
				t.Fatalf("invalid path redirected: %s", response.Header().Get("Location"))
			}
		}
	}
	for _, target := range []string{strings.Replace(base, "/api/v1/", "/api//v1/", 1) + "keep", taskPath(task) + "/preview", taskPath(task) + "/attachments/files"} {
		assertProjectError(t, attachmentRequest(handler, http.MethodPut, target, "text/plain", nil), http.StatusBadRequest, "invalid_input")
	}
	f.expectRead(task, "keep", item, nil)
	response := attachmentRequest(handler, http.MethodGet, base+"keep", "", nil)
	f.verify()
	if response.Code != http.StatusOK || response.Body.String() != "unchanged" {
		t.Fatal("rejected file path changed file")
	}
	f.expectList(task, store.AttachmentQuery{Limit: 50}, store.AttachmentPage{Items: []model.Attachment{item}}, nil)
	page := decodeResponse[api.AttachmentPage](t, attachmentRequest(handler, http.MethodGet, taskPath(task)+"/attachments", "", nil), http.StatusOK)
	f.verify()
	if len(page.Items) != 1 {
		t.Fatalf("invalid request created files: %+v", page)
	}
}

func TestAttachmentHTTPScopesConflictsAndFailures(t *testing.T) {
	files := attachmentTestFiles(t)
	var logs bytes.Buffer
	f := newAttachmentFixture(t, files, &logs)
	handler, task := f.handler, f.task
	file := attachmentFilePath(task, "docs/design.md")
	item := f.item(task, "docs/design.md", "application/octet-stream", 0)
	f.expectPut(task, item.Path, item.ContentType, 0, item, true)
	decodeResponse[api.Attachment](t, attachmentRequest(handler, http.MethodPut, file, "", nil), http.StatusCreated)
	f.verify()
	for _, collision := range []string{"docs", "docs/design.md/child"} {
		f.expectConflict(task, collision)
		assertProjectError(t, attachmentRequest(handler, http.MethodPut, attachmentFilePath(task, collision), "text/plain", nil), http.StatusConflict, "path_conflict")
		f.verify()
	}
	for _, owner := range []string{"00000000-0000-4000-8000-000000000098", "00000000-0000-4000-8000-000000000099"} {
		requested := task
		requested.ProjectID = owner
		var accessErr error
		if owner == "00000000-0000-4000-8000-000000000099" {
			accessErr = model.ErrNotFound
		}
		for _, method := range []string{http.MethodPut, http.MethodGet, http.MethodDelete} {
			if method != http.MethodDelete {
				f.expectReadFailure(requested, accessErr, store.TaskPresence{Found: false})
			} else {
				f.begin()
			}
			if method != http.MethodGet {
				f.expectMutationFailure(requested, true, store.TaskPresence{Found: false}, accessErr)
			}
			assertProjectError(t, attachmentRequest(handler, method, attachmentFilePath(requested, item.Path), "text/plain", nil), http.StatusNotFound, "not_found")
			f.verify()
		}
		f.expectReadFailure(requested, accessErr, store.TaskPresence{Found: false})
		assertProjectError(t, attachmentRequest(handler, http.MethodGet, taskPath(requested)+"/attachments", "", nil), http.StatusNotFound, "not_found")
		f.verify()
	}
	for _, target := range []string{strings.Replace(file, task.ProjectID, "bad-project", 1), strings.Replace(file, task.ID, "bad-task", 1), strings.Replace(taskPath(task)+"/attachments", task.ID, "bad-task", 1)} {
		assertProjectError(t, attachmentRequest(handler, http.MethodGet, target, "", nil), http.StatusBadRequest, "invalid_input")
		if strings.Contains(target, "/attachments/files/") {
			assertProjectError(t, attachmentRequest(handler, http.MethodPut, target, "text/plain", nil), http.StatusBadRequest, "invalid_input")
		}
	}
	for _, contentType := range []string{"not a mime", "text/plain; invalid", "text/plain; charset=utf-8; charset=latin1"} {
		assertProjectError(t, attachmentRequest(handler, http.MethodPut, file, contentType, nil), http.StatusBadRequest, "invalid_input")
	}
	if err := files.Delete(context.Background(), "task-attachments", task.ProjectID+"/"+task.ID[:2]+"/"+task.ID+"/docs/design.md"); err != nil {
		t.Fatal(err)
	}
	f.expectRead(task, item.Path, item, nil)
	assertProjectError(t, attachmentRequest(handler, http.MethodGet, file, "", nil), http.StatusInternalServerError, "internal_error")
	f.verify()
	databaseError := &store.Error{Phase: "query", DatabaseFailure: true, Cause: errors.New("private_secret_table")}
	f.expectPutError(task, item.Path, databaseError)
	assertProjectError(t, attachmentRequest(handler, http.MethodPut, file, "text/plain", nil), http.StatusInternalServerError, "internal_error")
	f.verify()
	f.expectRead(task, item.Path, model.Attachment{}, databaseError)
	assertProjectError(t, attachmentRequest(handler, http.MethodGet, file, "", nil), http.StatusInternalServerError, "internal_error")
	f.verify()
	f.expectList(task, store.AttachmentQuery{Limit: 50}, store.AttachmentPage{}, databaseError)
	assertProjectError(t, attachmentRequest(handler, http.MethodGet, taskPath(task)+"/attachments", "", nil), http.StatusInternalServerError, "internal_error")
	f.verify()
	if strings.Contains(logs.String(), "private_secret") || strings.Contains(logs.String(), "objects/") || !strings.Contains(logs.String(), `"error_code":"path_conflict"`) || !strings.Contains(logs.String(), `"cause":"database"`) {
		t.Fatalf("unsafe or missing error diagnostic: %s", &logs)
	}
}

type attachmentOpenStorage struct {
	filestorage.Storage
	object filestorage.Object
	err    error
}

func (s attachmentOpenStorage) Open(context.Context, string, string) (filestorage.Object, error) {
	return s.object, s.err
}

type attachmentFailingBody struct {
	data     []byte
	readErr  error
	closeErr error
	closed   bool
	cancel   context.CancelFunc
}

func (r *attachmentFailingBody) Read(buffer []byte) (int, error) {
	if r.cancel != nil {
		r.cancel()
	}
	count := copy(buffer, r.data)
	r.data = r.data[count:]
	if len(r.data) == 0 {
		if r.readErr != nil {
			return count, r.readErr
		}
		return count, io.EOF
	}
	return count, nil
}

func (r *attachmentFailingBody) Close() error {
	r.closed = true
	return r.closeErr
}

type attachmentFailingWriter struct{ *httptest.ResponseRecorder }

func (w attachmentFailingWriter) Write([]byte) (int, error) {
	return 0, errors.New("private-writer-secret")
}

func TestAttachmentHTTPStreamErrorsAndCancellation(t *testing.T) {
	files := attachmentTestFiles(t)
	for _, item := range []struct {
		name                  string
		data                  string
		readErr, closeErr     error
		length                int64
		abort, cancel, writer bool
	}{
		{name: "open", readErr: errors.New("private-read-secret"), length: 5},
		{name: "empty close", closeErr: errors.New("private-close-secret")},
		{name: "read", data: "hel", readErr: errors.New("private-read-secret"), length: 5, abort: true},
		{name: "truncated", data: "hel", length: 5, abort: true},
		{name: "close", data: "hello", length: 5, closeErr: errors.New("private-close-secret"), abort: true},
		{name: "writer", data: "hello", length: 5, writer: true, abort: true},
		{name: "canceled", data: "hello", length: 5, cancel: true},
	} {
		t.Run(item.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			body := &attachmentFailingBody{data: []byte(item.data), readErr: item.readErr, closeErr: item.closeErr}
			if item.cancel {
				body.cancel = cancel
			}
			storage := attachmentOpenStorage{Storage: files, object: filestorage.Object{Body: body, Info: filestorage.FileInfo{Size: item.length}}}
			var logs bytes.Buffer
			f := newAttachmentFixture(t, storage, &logs)
			handler, task := f.handler, f.task
			location := attachmentFilePath(task, "stream.txt")
			f.expectRead(task, "stream.txt", f.item(task, "stream.txt", "text/plain", 5), nil)
			request := httptest.NewRequest(http.MethodGet, location, nil).WithContext(ctx)
			authorizeResourceRequest(handler, request)
			request.Header.Set("X-Request-ID", "project-test")
			response := httptest.NewRecorder()
			var writer http.ResponseWriter = response
			if item.writer {
				writer = attachmentFailingWriter{response}
			}
			var recovered any
			func() {
				defer func() { recovered = recover() }()
				handler.ServeHTTP(writer, request)
			}()
			f.verify()
			if item.abort != (recovered == http.ErrAbortHandler) || !body.closed {
				t.Fatalf("stream abort/close: %v closed=%v", recovered, body.closed)
			}
			if item.abort {
				if strings.Contains(response.Body.String(), `"error"`) || strings.Contains(logs.String(), `"cause":"panic"`) {
					t.Fatalf("stream polluted or duplicate panic diagnostic: %s %s", response.Body, &logs)
				}
			} else if item.cancel {
				if response.Body.Len() != 0 || !strings.Contains(logs.String(), `"cause":"canceled"`) {
					t.Fatalf("canceled response: %s %s", response.Body, &logs)
				}
			} else {
				assertProjectError(t, response, http.StatusInternalServerError, "internal_error")
				if response.Header().Get("Content-Length") != "" || response.Header().Get("Content-Disposition") != "" {
					t.Fatalf("content headers on JSON error: %+v", response.Header())
				}
			}
			if strings.Count(logs.String(), `"type":"operation_error"`) != 1 || strings.Contains(logs.String(), "private-") {
				t.Fatalf("failure diagnostic count/redaction: %s", &logs)
			}
		})
	}
}

func TestAttachmentHTTPUploadStreamFailureAndCancel(t *testing.T) {
	files := attachmentTestFiles(t)
	var logs bytes.Buffer
	f := newAttachmentFixture(t, files, &logs)
	handler, task := f.handler, f.task
	location := attachmentFilePath(task, "upload.bin")
	for _, canceled := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		body := &attachmentFailingBody{data: []byte("partial"), readErr: errors.New("private-upload-secret")}
		if canceled {
			body.cancel = cancel
		}
		request := httptest.NewRequest(http.MethodPut, location, body).WithContext(ctx)
		authorizeResourceRequest(handler, request)
		request.Header.Set("Content-Type", "application/octet-stream")
		request.Header.Set("X-Request-ID", "project-test")
		response := httptest.NewRecorder()
		f.expectAdmission(task, "upload.bin")
		handler.ServeHTTP(response, request)
		f.verify()
		cancel()
		if !body.closed {
			t.Fatal("upload stream was not closed")
		}
		if canceled {
			if response.Body.Len() != 0 {
				t.Fatalf("canceled upload response: %s", response.Body)
			}
		} else {
			assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
		}
		f.expectRead(task, "upload.bin", model.Attachment{}, model.ErrNotFound)
		assertProjectError(t, attachmentRequest(handler, http.MethodGet, location, "", nil), http.StatusNotFound, "not_found")
		f.verify()
	}
	request := httptest.NewRequest(http.MethodPut, location, nil)
	authorizeResourceRequest(handler, request)
	request.Header["Content-Type"] = []string{"text/plain", "image/png"}
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
	if strings.Contains(logs.String(), "private-upload-secret") || !strings.Contains(logs.String(), `"cause":"canceled"`) {
		t.Fatalf("upload diagnostic: %s", &logs)
	}
}

func TestAttachmentHTTPTransportAbortsTruncatedContent(t *testing.T) {
	files := attachmentTestFiles(t)
	payload := bytes.Repeat([]byte{255}, 16*1024)
	body := &attachmentFailingBody{data: payload, readErr: errors.New("private-stream-secret")}
	storage := attachmentOpenStorage{Storage: files, object: filestorage.Object{Body: body, Info: filestorage.FileInfo{Size: int64(len(payload) + 10)}}}
	f := newAttachmentFixture(t, storage, io.Discard)
	streamHandler, task := f.handler, f.task
	location := attachmentFilePath(task, "stream.bin")
	f.expectRead(task, "stream.bin", f.item(task, "stream.bin", "application/octet-stream", 8), nil)
	server := httptest.NewServer(streamHandler)
	defer server.Close()
	client := server.Client()
	client.Timeout = 5 * time.Second
	request, err := http.NewRequest(http.MethodGet, server.URL+location, nil)
	if err != nil {
		t.Fatal(err)
	}
	authorizeResourceRequest(streamHandler, request)
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	content, readErr := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	f.verify()
	if !errors.Is(readErr, io.ErrUnexpectedEOF) || closeErr != nil || !bytes.Equal(content, payload) || response.StatusCode != http.StatusOK {
		t.Fatalf("truncated HTTP body: bytes=%d status=%d read=%v close=%v", len(content), response.StatusCode, readErr, closeErr)
	}
}

func TestAttachmentHTTPMalformedPrefixCannotRedirectIntoTask(t *testing.T) {
	f := newAttachmentFixture(t, attachmentTestFiles(t), io.Discard)
	handler, task, project := f.handler, f.task, f.project
	canonicalCalls := 0
	f.mux.HandleFunc(taskPath(task), func(w http.ResponseWriter, request *http.Request) {
		canonicalCalls++
		if request.Method != http.MethodPatch {
			t.Errorf("unexpected neighboring JSON route method: %s", request.Method)
		}
		var input struct {
			Version int64  `json:"version"`
			Title   string `json:"title"`
		}
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil || input.Version != task.Version {
			t.Errorf("canonical JSON input: %+v %v", input, err)
		}
		updated := task
		updated.Title, updated.Version = input.Title, input.Version+1
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(updated); err != nil {
			t.Error(err)
		}
	})
	body := []byte(jsonBody(t, map[string]any{"version": task.Version, "title": "unintended redirected mutation"}))
	for _, target := range []string{
		strings.Replace(taskPath(task), "/api/v1/", "/api//v1/", 1) + "/attachments/files/../..",
		strings.Replace(taskPath(task), "/projects/", "/./projects/", 1) + "/preview/..",
		taskPath(task) + "/extra/../attachments/files/../..",
		taskPath(task) + "//preview/..",
		taskPath(task) + "/attachments%2Ffiles/../..",
		taskPath(task) + "/attachments%5Cfiles/../..",
		strings.Replace(taskPath(task), "/api/v1/", "/api%2Fv1/", 1) + "/preview/..",
		strings.Replace(taskPath(task), "/api/v1/", "/../api/v1/", 1) + "/preview/..",
		taskCollection(project.ID) + "/./attachments/files/file",
		taskCollection(project.ID) + "/%2F/attachments/files/file",
	} {
		for _, method := range []string{http.MethodPatch, http.MethodPut, http.MethodDelete} {
			response := attachmentRequest(handler, method, target, "application/json", body)
			assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
			if response.Header().Get("Location") != "" {
				t.Fatalf("attachment intent redirected to %s", response.Header().Get("Location"))
			}
		}
	}
	if canonicalCalls != 0 {
		t.Fatalf("invalid attachment URL reached neighboring JSON route %d times", canonicalCalls)
	}
	canonical := projectRequest(handler, http.MethodPatch, taskPath(task), string(body))
	updated := decodeResponse[api.Task](t, canonical, http.StatusOK)
	if updated.Title != "unintended redirected mutation" || updated.Version != task.Version+1 || canonicalCalls != 1 {
		t.Fatalf("valid old JSON route changed behavior: %+v", updated)
	}
	ordinary := strings.Replace(taskPath(task), "/api/v1/", "/api//v1/", 1)
	response := projectRequest(handler, http.MethodGet, ordinary, "")
	if response.Code != http.StatusTemporaryRedirect || response.Header().Get("Location") != taskPath(task) {
		t.Fatalf("ordinary old JSON normalization changed: %d %+v", response.Code, response.Header())
	}
}
