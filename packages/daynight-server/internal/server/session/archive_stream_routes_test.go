package session_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

type streamArchiveStub struct {
	*unifiedArchiveStub
	t          *testing.T
	calls      int
	fileV2     func(context.Context, string, string, int64, int64, string, io.Reader) (sp.ArchiveFileReceipt, error)
	resourceV2 func(context.Context, string, int64, int64, string, io.Reader, sp.Resource) (sp.ArchiveFileReceipt, error)
	complete   func(context.Context, string, string) (sp.ArchiveFileReceipt, error)
	restart    func(context.Context, string, string, string) (sp.ArchiveFileReceipt, error)
}

func (s *streamArchiveStub) PutArchiveFileV2(ctx context.Context, purpose, id string, offset, length int64, digest string, body io.Reader) (sp.ArchiveFileReceipt, error) {
	s.calls++
	if s.fileV2 != nil {
		return s.fileV2(ctx, purpose, id, offset, length, digest, body)
	}
	data, err := io.ReadAll(body)
	if err != nil || purpose != "history" || offset != 2 || length != 6 || digest != strings.Repeat("a", 64) || string(data) != "cdef" {
		s.t.Fatalf("unexpected stream: %q %d %d %q %q %v", purpose, offset, length, digest, data, err)
	}
	return sp.ArchiveFileReceipt{FileID: id, State: "receiving", AcceptedOffset: "6", ByteLength: "6", SHA256: digest}, nil
}
func (s *streamArchiveStub) PutArchiveResourceV2(ctx context.Context, id string, offset, length int64, hash string, body io.Reader, resource sp.Resource) (sp.ArchiveFileReceipt, error) {
	s.calls++
	if s.resourceV2 != nil {
		return s.resourceV2(ctx, id, offset, length, hash, body, resource)
	}
	s.t.Fatal("unexpected resource")
	return sp.ArchiveFileReceipt{}, nil
}
func (s *streamArchiveStub) CompleteArchiveFile(ctx context.Context, purpose, id string) (sp.ArchiveFileReceipt, error) {
	s.calls++
	if s.complete != nil {
		return s.complete(ctx, purpose, id)
	}
	return sp.ArchiveFileReceipt{State: "complete"}, nil
}
func (s *streamArchiveStub) RestartArchiveFile(ctx context.Context, purpose, id, successor string) (sp.ArchiveFileReceipt, error) {
	s.calls++
	if s.restart != nil {
		return s.restart(ctx, purpose, id, successor)
	}
	return sp.ArchiveFileReceipt{State: "receiving"}, nil
}

func TestArchiveStreamRoutes(t *testing.T) {
	f := archiveHTTPSetup(t)
	base := f.base + "/" + f.snapshot.SessionID + "/archive/prepare/history/" + uuid.NewString()
	var stub *streamArchiveStub
	original := f.backend.Funcs.BeginArchiveReserved
	f.backend.Funcs.BeginArchiveReserved = func(ctx context.Context, p model.Principal, project, task, id string, mode sessioncore.ArchiveMode, lease io.Closer) (sessionhttp.ArchiveOperationForTest, error) {
		op, err := original(ctx, p, project, task, id, mode, lease)
		if err != nil {
			return nil, err
		}
		stub = &streamArchiveStub{unifiedArchiveStub: &unifiedArchiveStub{archiveUploadStub: op.(*archiveUploadStub)}, t: t}
		return stub, nil
	}
	request := func(length string, body string) *http.Request {
		r := httptest.NewRequest(http.MethodPut, base+"?offset=2", strings.NewReader(body))
		authorizeResourceRequest(f.handler, r)
		r.Header.Set("Content-Type", "application/octet-stream")
		r.Header.Set("Daynight-Archive-Upload-Version", "2")
		r.Header.Set("Daynight-File-Byte-Length", length)
		r.Header.Set("Daynight-File-SHA256", strings.Repeat("a", 64))
		return r
	}
	for _, tc := range []struct {
		length, body string
		want         int
	}{{"6", "cdef", 200}, {"7", "cdef", 400}, {"6", "abcdef", 400}} {
		calls := map[string]int{"TryReserveArchivePreflight": 1}
		if tc.want == 200 {
			calls["BeginArchiveReserved"] = 1
		}
		f.Expect(calls)
		f.auth.ExpectCalls(1)
		w := httptest.NewRecorder()
		f.handler.ServeHTTP(w, request(tc.length, tc.body))
		if w.Code != tc.want {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
		if tc.want == 200 && (stub == nil || stub.calls != 1 || w.Header().Get("Daynight-Archive-Upload-Version") != "2") {
			t.Fatal("stream or version missing")
		}
	}
}

func TestArchiveStreamStatusAndCapability(t *testing.T) {
	f := archiveHTTPSetup(t)
	id := uuid.NewString()
	base := f.base + "/" + f.snapshot.SessionID + "/archive"
	f.backend.Funcs.ArchiveFileStatus = func(_ context.Context, _ model.Principal, _, _, _, file string) (sp.ArchiveFileReceipt, error) {
		receipt := sp.ArchiveFileReceipt{FileID: file, UploadVersion: 2, State: "receiving", ByteLength: "6", SHA256: strings.Repeat("a", 64)}
		return sp.ArchiveFileReceipt{}, &sessioncore.ArchiveStagingCorruptError{Receipt: receipt}
	}
	w := f.Request(http.MethodGet, base+"/prepare/history/"+id+"/status", "", map[string]int{"ArchiveFileStatus": 1})
	if w.Code != http.StatusConflict || w.Header().Get("Daynight-Archive-Upload-Version") != "2" || !strings.Contains(w.Body.String(), `"code":"staging_corrupt"`) || !strings.Contains(w.Body.String(), `"syncId":"`+id+`"`) {
		t.Fatalf("status=%d header=%v body=%s", w.Code, w.Header(), w.Body.String())
	}
	f.backend.Funcs.ArchiveFileStatus = func(_ context.Context, _ model.Principal, _, _, _, file string) (sp.ArchiveFileReceipt, error) {
		observation := &sessioncore.ArchiveStagingCorruptError{Receipt: sp.ArchiveFileReceipt{FileID: file, UploadVersion: 2, ByteLength: "6", SHA256: strings.Repeat("a", 64)}}
		return sp.ArchiveFileReceipt{}, &model.Fault{Code: "cleanup_unknown", Message: "Archive cleanup failed.", Cause: errors.Join(observation, errors.New("close failed"))}
	}
	w = f.Request(http.MethodGet, base+"/prepare/history/"+id+"/status", "", map[string]int{"ArchiveFileStatus": 1})
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), `"code":"cleanup_unknown"`) || strings.Contains(w.Body.String(), `"code":"staging_corrupt"`) || strings.Contains(w.Body.String(), `"syncId"`) {
		t.Fatalf("cleanup failure status=%d body=%s", w.Code, w.Body.String())
	}
	f.application.(*routeApplication).Routes.SetArchiveUploadV2Enabled(true)
	f.backend.Funcs.ArchivePreparation = func(context.Context, model.Principal, string, string, string) (sp.ArchivePrepareReceipt, error) {
		return sp.ArchivePrepareReceipt{}, nil
	}
	w = f.Request(http.MethodGet, base+"/prepare", "", map[string]int{"ArchivePreparation": 1})
	if w.Code != http.StatusOK || w.Header().Get("Daynight-Archive-Upload-Version") != "2" {
		t.Fatalf("status=%d header=%v body=%s", w.Code, w.Header(), w.Body.String())
	}
	f.application.(*routeApplication).Routes.SetArchiveUploadV2Enabled(false)
	w = f.Request(http.MethodGet, base+"/prepare", "", map[string]int{"ArchivePreparation": 1})
	if w.Code != http.StatusOK || w.Header().Get("Daynight-Archive-Upload-Version") != "" {
		t.Fatalf("status=%d header=%v body=%s", w.Code, w.Header(), w.Body.String())
	}
}

func TestArchiveStreamActions(t *testing.T) {
	f := archiveHTTPSetup(t)
	base := f.base + "/" + f.snapshot.SessionID + "/archive/prepare/history/" + uuid.NewString()
	original := f.backend.Funcs.BeginArchiveReserved
	var stub *streamArchiveStub
	f.backend.Funcs.BeginArchiveReserved = func(ctx context.Context, p model.Principal, project, task, id string, mode sessioncore.ArchiveMode, lease io.Closer) (sessionhttp.ArchiveOperationForTest, error) {
		op, err := original(ctx, p, project, task, id, mode, lease)
		if err != nil {
			return nil, err
		}
		stub = &streamArchiveStub{unifiedArchiveStub: &unifiedArchiveStub{archiveUploadStub: op.(*archiveUploadStub)}, t: t}
		return stub, nil
	}
	for _, tc := range []struct {
		path, body           string
		expected, operations int
	}{
		{"/complete", "", 200, 1},
		{"/restart", `{"replacementFileId":"` + uuid.NewString() + `"}`, 200, 1},
		{"/restart", `{"replacementFileId":"bad"}`, 400, 0},
		{"/restart", `{`, 400, 0},
	} {
		f.Expect(map[string]int{"TryReserveArchivePreflight": 1, "BeginArchiveReserved": 1})
		f.auth.ExpectCalls(1)
		r := httptest.NewRequest(http.MethodPost, base+tc.path, strings.NewReader(tc.body))
		authorizeResourceRequest(f.handler, r)
		r.Header.Set("Daynight-Archive-Upload-Version", "2")
		if tc.path == "/restart" {
			r.Header.Set("Content-Type", "application/json")
		}
		w := httptest.NewRecorder()
		f.handler.ServeHTTP(w, r)
		if w.Code != tc.expected || stub.calls != tc.operations {
			t.Fatalf("%s: status=%d calls=%d body=%s", tc.path, w.Code, stub.calls, w.Body.String())
		}
	}
}

func installStreamStub(f *archiveHTTPFixture, configure func(*streamArchiveStub)) {
	original := f.backend.Funcs.BeginArchiveReserved
	f.backend.Funcs.BeginArchiveReserved = func(ctx context.Context, p model.Principal, project, task, id string, mode sessioncore.ArchiveMode, lease io.Closer) (sessionhttp.ArchiveOperationForTest, error) {
		op, err := original(ctx, p, project, task, id, mode, lease)
		if err != nil {
			return nil, err
		}
		stub := &streamArchiveStub{unifiedArchiveStub: &unifiedArchiveStub{archiveUploadStub: op.(*archiveUploadStub)}, t: f.t}
		configure(stub)
		return stub, nil
	}
}

func TestArchiveStreamTimelineAndEmptyMigrationResource(t *testing.T) {
	for _, kind := range []string{"timeline", "resource"} {
		t.Run(kind, func(t *testing.T) {
			f := archiveHTTPSetup(t)
			id, digest := uuid.NewString(), strings.Repeat("a", 64)
			path := f.base + "/" + f.snapshot.SessionID + "/archive/files/" + id + "?offset=0"
			body, length := "{}", "2"
			headers := map[string]string{"Content-Type": "application/octet-stream", "Daynight-Archive-Upload-Version": "2", "Daynight-File-Byte-Length": length, "Daynight-File-SHA256": digest}
			media := "text/plain"
			resource := sp.Resource{ResourceID: uuid.NewString(), Status: "available", Name: "empty", MediaType: &media, ByteLength: &length, SHA256: &digest}
			if kind == "resource" {
				path += "&purpose=resource&migrationOnly=true"
				body, length, digest = "", "0", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
				resource.ByteLength, resource.SHA256 = &length, &digest
				headers["Daynight-File-Byte-Length"], headers["Daynight-File-SHA256"] = length, digest
				headers["Daynight-Resource-Descriptor"] = jsonBody(t, resource)
			}
			called := 0
			installStreamStub(f, func(op *streamArchiveStub) {
				op.fileV2 = func(ctx context.Context, purpose, file string, offset, total int64, hash string, input io.Reader) (sp.ArchiveFileReceipt, error) {
					called++
					data, err := io.ReadAll(input)
					if err != nil || ctx.Err() != nil || kind != "timeline" || purpose != "timeline" || file != id || offset != 0 || total != 2 || hash != digest || string(data) != body {
						t.Fatalf("timeline arguments: %q %q %d %d %q %q %v", purpose, file, offset, total, hash, data, err)
					}
					return sp.ArchiveFileReceipt{FileID: file, State: "receiving", ByteLength: length, AcceptedOffset: length, SHA256: hash}, nil
				}
				op.resourceV2 = func(ctx context.Context, file string, offset, total int64, hash string, input io.Reader, actual sp.Resource) (sp.ArchiveFileReceipt, error) {
					called++
					data, err := io.ReadAll(input)
					if err != nil || ctx.Err() != nil || kind != "resource" || file != id || offset != 0 || total != 0 || hash != digest || len(data) != 0 || !reflect.DeepEqual(actual, resource) {
						t.Fatalf("resource arguments: %q %d %d %q %+v %v", file, offset, total, hash, actual, err)
					}
					return sp.ArchiveFileReceipt{FileID: file, State: "receiving", ByteLength: length, AcceptedOffset: length, SHA256: hash}, nil
				}
			})
			w := archiveBoundaryRequest(f, http.MethodPut, path, body, headers, map[string]int{"TryReserveArchivePreflight": 1, "BeginArchiveReserved": 1})
			if w.Code != http.StatusOK || called != 1 || w.Header().Get("Daynight-Archive-Upload-Version") != "2" || !strings.Contains(w.Body.String(), `"fileId":"`+id+`"`) {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
			f.AssertReleased(t)
		})
	}
}

func TestArchiveStreamRefusesMalformedRequestsBeforeAdmission(t *testing.T) {
	for _, kind := range []string{"unknown query", "missing offset", "chunk digest", "unknown version", "invalid profile", "missing descriptor", "invalid descriptor", "encoded", "chunked", "too large"} {
		t.Run(kind, func(t *testing.T) {
			f := archiveHTTPSetup(t)
			path := f.base + "/" + f.snapshot.SessionID + "/archive/files/" + uuid.NewString() + "?offset=0"
			headers := map[string]string{"Content-Type": "application/octet-stream", "Daynight-Archive-Upload-Version": "2", "Daynight-File-Byte-Length": "2", "Daynight-File-SHA256": strings.Repeat("a", 64)}
			switch kind {
			case "unknown query":
				path += "&other=1"
			case "missing offset":
				path = strings.TrimSuffix(path, "?offset=0")
			case "chunk digest":
				headers["Daynight-Chunk-SHA256"] = strings.Repeat("a", 64)
			case "unknown version":
				headers["Daynight-Archive-Upload-Version"] = "3"
			case "invalid profile":
				path += "&purpose=resource"
			case "missing descriptor":
				path += "&purpose=resource&migrationOnly=true"
			case "invalid descriptor":
				path += "&purpose=resource&migrationOnly=true"
				headers["Daynight-Resource-Descriptor"] = "{}"
			case "encoded":
				headers["Content-Encoding"] = "gzip"
			case "too large":
				headers["Daynight-File-Byte-Length"] = "134217729"
			}
			f.Expect(map[string]int{"TryReserveArchivePreflight": 1})
			f.auth.ExpectCalls(1)
			r := httptest.NewRequest(http.MethodPut, path, strings.NewReader("{}"))
			authorizeResourceRequest(f.handler, r)
			for k, v := range headers {
				r.Header.Set(k, v)
			}
			if kind == "chunked" {
				r.TransferEncoding = []string{"chunked"}
			}
			w := httptest.NewRecorder()
			f.handler.ServeHTTP(w, r)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
			f.AssertReleased(t)
		})
	}
}

func TestArchiveStreamTimelineActionsPreserveIdentity(t *testing.T) {
	f := archiveHTTPSetup(t)
	id, successor := uuid.NewString(), uuid.NewString()
	base := f.base + "/" + f.snapshot.SessionID + "/archive/files/" + id
	installStreamStub(f, func(op *streamArchiveStub) {
		op.complete = func(ctx context.Context, purpose, file string) (sp.ArchiveFileReceipt, error) {
			if ctx.Err() != nil || purpose != "timeline" || file != id {
				t.Fatal("complete identity changed")
			}
			return sp.ArchiveFileReceipt{FileID: file, State: "complete"}, nil
		}
		op.restart = func(ctx context.Context, purpose, file, next string) (sp.ArchiveFileReceipt, error) {
			if ctx.Err() != nil || purpose != "timeline" || file != id || next != successor {
				t.Fatal("restart identity changed")
			}
			return sp.ArchiveFileReceipt{FileID: file, State: "failed", SuccessorFileID: &next}, nil
		}
	})
	for _, tc := range []struct{ path, body string }{{"/complete", ""}, {"/restart", `{"replacementFileId":"` + successor + `"}`}} {
		headers := map[string]string{"Daynight-Archive-Upload-Version": "2"}
		if tc.body != "" {
			headers["Content-Type"] = "application/json"
		}
		w := archiveBoundaryRequest(f, http.MethodPost, base+tc.path, tc.body, headers, map[string]int{"TryReserveArchivePreflight": 1, "BeginArchiveReserved": 1})
		if w.Code != http.StatusOK || w.Header().Get("Daynight-Archive-Upload-Version") != "2" || !strings.Contains(w.Body.String(), `"fileId":"`+id+`"`) {
			t.Fatalf("%s: %d %s", tc.path, w.Code, w.Body.String())
		}
	}
}

func TestArchiveStreamActionRefusals(t *testing.T) {
	for _, kind := range []string{"unknown query", "missing version", "complete with body", "restart content type", "unknown field", "trailing json", "core refusal", "unsupported operation"} {
		t.Run(kind, func(t *testing.T) {
			f := archiveHTTPSetup(t)
			base := f.base + "/" + f.snapshot.SessionID + "/archive/files/" + uuid.NewString()
			path, body := base+"/complete", ""
			headers := map[string]string{"Daynight-Archive-Upload-Version": "2"}
			calls := map[string]int{"TryReserveArchivePreflight": 1}
			begin := true
			switch kind {
			case "unknown query":
				path += "?unexpected=1"
				begin = false
			case "missing version":
				delete(headers, "Daynight-Archive-Upload-Version")
				begin = false
			case "complete with body":
				body = "x"
				begin = false
			case "restart content type":
				path = base + "/restart"
				body = `{}`
				headers["Content-Type"] = "text/plain"
			case "unknown field":
				path = base + "/restart"
				body = `{"replacementFileId":"` + uuid.NewString() + `","extra":1}`
				headers["Content-Type"] = "application/json"
			case "trailing json":
				path = base + "/restart"
				body = `{"replacementFileId":"` + uuid.NewString() + `"} {}`
				headers["Content-Type"] = "application/json"
			}
			if begin {
				calls["BeginArchiveReserved"] = 1
			}
			if kind == "unsupported operation" {
				setupUnifiedStub(f, func(*unifiedArchiveStub) {})
			} else {
				installStreamStub(f, func(op *streamArchiveStub) {
					op.complete = func(context.Context, string, string) (sp.ArchiveFileReceipt, error) {
						if kind != "core refusal" {
							t.Fatal("invalid action reached core")
						}
						return sp.ArchiveFileReceipt{}, &model.Fault{Code: "archive_conflict", Message: "Original file changed."}
					}
				})
			}
			w := archiveBoundaryRequest(f, http.MethodPost, path, body, headers, calls)
			want := http.StatusBadRequest
			if kind == "core refusal" {
				want = http.StatusConflict
			}
			if w.Code != want {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
			f.AssertReleased(t)
		})
	}
}

func TestArchiveStreamCancellationReachesOperation(t *testing.T) {
	f := archiveHTTPSetup(t)
	path := f.base + "/" + f.snapshot.SessionID + "/archive/files/" + uuid.NewString() + "?offset=0"
	started := make(chan struct{})
	exited := make(chan struct{})
	installStreamStub(f, func(op *streamArchiveStub) {
		op.fileV2 = func(ctx context.Context, _ string, _ string, _, _ int64, _ string, _ io.Reader) (sp.ArchiveFileReceipt, error) {
			close(started)
			<-ctx.Done()
			close(exited)
			return sp.ArchiveFileReceipt{}, ctx.Err()
		}
	})
	f.Expect(map[string]int{"TryReserveArchivePreflight": 1, "BeginArchiveReserved": 1})
	f.auth.ExpectCalls(1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := httptest.NewRequest(http.MethodPut, path, strings.NewReader("{}"))
	r = r.WithContext(ctx)
	authorizeResourceRequest(f.handler, r)
	r.Header.Set("Content-Type", "application/octet-stream")
	r.Header.Set("Daynight-Archive-Upload-Version", "2")
	r.Header.Set("Daynight-File-Byte-Length", "2")
	r.Header.Set("Daynight-File-SHA256", strings.Repeat("a", 64))
	done := make(chan any, 1)
	go func() {
		defer func() { done <- recover() }()
		f.handler.ServeHTTP(httptest.NewRecorder(), r)
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("stream operation did not start")
	}
	cancel()
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled operation did not exit")
	}
	select {
	case outcome := <-done:
		if outcome != http.ErrAbortHandler {
			t.Fatalf("canceled handler did not abort: %v", outcome)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("handler did not finish")
	}
	f.AssertReleased(t)
}

func TestArchiveStreamChecksConsumedAndExtraBytes(t *testing.T) {
	for _, kind := range []string{"short", "extra", "unconsumed"} {
		t.Run(kind, func(t *testing.T) {
			f := archiveHTTPSetup(t)
			path := f.base + "/" + f.snapshot.SessionID + "/archive/files/" + uuid.NewString() + "?offset=0"
			body := "{}"
			if kind == "short" {
				body = "{"
			}
			if kind == "extra" {
				body = "{}x"
			}
			called := 0
			installStreamStub(f, func(op *streamArchiveStub) {
				op.fileV2 = func(_ context.Context, _ string, _ string, _, _ int64, _ string, input io.Reader) (sp.ArchiveFileReceipt, error) {
					called++
					if kind != "unconsumed" {
						if _, err := io.ReadAll(input); err != nil {
							return sp.ArchiveFileReceipt{}, err
						}
					}
					return sp.ArchiveFileReceipt{State: "receiving"}, nil
				}
			})
			f.Expect(map[string]int{"TryReserveArchivePreflight": 1, "BeginArchiveReserved": 1})
			f.auth.ExpectCalls(1)
			r := httptest.NewRequest(http.MethodPut, path, strings.NewReader(body))
			r.ContentLength = 2
			authorizeResourceRequest(f.handler, r)
			r.Header.Set("Content-Type", "application/octet-stream")
			r.Header.Set("Daynight-Archive-Upload-Version", "2")
			r.Header.Set("Daynight-File-Byte-Length", "2")
			r.Header.Set("Daynight-File-SHA256", strings.Repeat("a", 64))
			w := httptest.NewRecorder()
			f.handler.ServeHTTP(w, r)
			if w.Code != http.StatusBadRequest || called != 1 {
				t.Fatalf("status=%d calls=%d body=%s", w.Code, called, w.Body.String())
			}
			f.AssertReleased(t)
		})
	}
}
