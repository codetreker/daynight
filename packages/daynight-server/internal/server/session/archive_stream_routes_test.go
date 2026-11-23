package session_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

type streamArchiveStub struct {
	*unifiedArchiveStub
	t     *testing.T
	calls int
}

func (s *streamArchiveStub) PutArchiveFileV2(_ context.Context, purpose, id string, offset, length int64, digest string, body io.Reader) (sp.ArchiveFileReceipt, error) {
	s.calls++
	data, err := io.ReadAll(body)
	if err != nil || purpose != "history" || offset != 2 || length != 6 || digest != strings.Repeat("a", 64) || string(data) != "cdef" {
		s.t.Fatalf("unexpected stream: %q %d %d %q %q %v", purpose, offset, length, digest, data, err)
	}
	return sp.ArchiveFileReceipt{FileID: id, State: "receiving", AcceptedOffset: "6", ByteLength: "6", SHA256: digest}, nil
}
func (s *streamArchiveStub) PutArchiveResourceV2(context.Context, string, int64, int64, string, io.Reader, sp.Resource) (sp.ArchiveFileReceipt, error) {
	s.t.Fatal("unexpected resource")
	return sp.ArchiveFileReceipt{}, nil
}
func (s *streamArchiveStub) CompleteArchiveFile(context.Context, string, string) (sp.ArchiveFileReceipt, error) {
	s.calls++
	return sp.ArchiveFileReceipt{State: "complete"}, nil
}
func (s *streamArchiveStub) RestartArchiveFile(context.Context, string, string, string) (sp.ArchiveFileReceipt, error) {
	s.calls++
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
