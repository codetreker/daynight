package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
)

func TestSessionArchiveRoutes(t *testing.T) {
	f := sessionHTTPSetup(t)
	base := f.base + "/" + f.snapshot.SessionID + "/archive"
	for _, method := range []string{http.MethodPut, http.MethodPost} {
		request := httptest.NewRequest(method, base, strings.NewReader("{}"))
		authorizeResourceRequest(f.handler, request)
		request.Header.Set("Content-Type", "text/plain")
		response := httptest.NewRecorder()
		f.handler.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s non-JSON archive body accepted: %d", method, response.Code)
		}
		if response = projectRequest(f.handler, method, base+"?unknown=1", "{}"); response.Code != http.StatusBadRequest {
			t.Fatalf("%s archive query accepted: %d", method, response.Code)
		}
	}
	status := decodeResponse[struct {
		Archive sp.ArchiveStatus `json:"archive"`
	}](t, projectRequest(f.handler, "GET", base, ""), 200)
	if status.Archive.State != "unavailable" {
		t.Fatal(status)
	}
	update := sp.ArchiveUpdate{Fence: f.snapshot.Fence, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, State: "pending"}
	decodeResponse[map[string]any](t, projectRequest(f.handler, "POST", base, jsonBody(t, update)), 200)
	doc := sp.ArchiveDocument{Fence: f.snapshot.Fence, SchemaVersion: 1, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex", Entries: []sp.TimelineEntry{}, Resources: []sp.ArchiveResource{}}
	if r := projectRequest(f.handler, "PUT", base, jsonBody(t, doc)); r.Code != 409 {
		t.Fatal(r.Code, r.Body.String())
	}
	if _, err := f.db.Pool.Exec(context.Background(), `UPDATE tasks SET status='done' WHERE id=$1`, f.task.ID); err != nil {
		t.Fatal(err)
	}
	status = decodeResponse[struct {
		Archive sp.ArchiveStatus `json:"archive"`
	}](t, projectRequest(f.handler, "PUT", base, jsonBody(t, doc)), 200)
	if status.Archive.State != "ready" {
		t.Fatal(status)
	}
	got := decodeResponse[map[string]any](t, projectRequest(f.handler, "GET", base+"/content", ""), 200)
	if got["archive"].(map[string]any)["sessionId"] != f.snapshot.SessionID {
		t.Fatal(got)
	}
	for _, path := range []string{base, base + "/content"} {
		for _, method := range []string{"HEAD", "DELETE"} {
			if r := projectRequest(f.handler, method, path, ""); r.Code != 405 {
				t.Fatal(method, r.Code)
			}
		}
		if r := projectRequest(f.handler, "GET", path+"?unknown=1", ""); r.Code != 400 {
			t.Fatal(r.Code)
		}
		req := httptest.NewRequest("GET", path, nil)
		rec := httptest.NewRecorder()
		f.handler.ServeHTTP(rec, req)
		if rec.Code != 401 {
			t.Fatal(rec.Code)
		}
	}
	for _, method := range []string{"PUT", "POST"} {
		if r := projectRequest(f.handler, method, base, "{}"); r.Code != 400 {
			t.Fatal(r.Code)
		}
	}
}
func TestArchiveBodyRejectsInvalidInputs(t *testing.T) {
	for _, test := range []struct {
		name, kind, query, body string
		fail                    bool
	}{
		{"valid", "application/json", "", "{}", false},
		{"charset", "application/json; charset=utf-8", "", "{}", false},
		{"media", "text/plain", "", "{}", true},
		{"wrong charset", "application/json; charset=utf-16", "", "{}", true},
		{"query", "application/json", "?bad=1", "{}", true},
		{"oversize", "application/json", "", strings.Repeat("a", sp.MaxArchiveBytes+1), true},
	} {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPut, "/archive"+test.query, strings.NewReader(test.body))
			req.Header.Set("Content-Type", test.kind)
			_, err := archiveBody(httptest.NewRecorder(), req)
			if (err != nil) != test.fail {
				t.Fatal(err)
			}
		})
	}
	req := httptest.NewRequest(http.MethodPut, "/archive", nil)
	req.Header.Set("Content-Type", "application/json")
	req.Body = io.NopCloser(archiveBrokenReader{})
	if _, err := archiveBody(httptest.NewRecorder(), req); err == nil {
		t.Fatal("read error ignored")
	}
}

type archiveBrokenReader struct{}

func (archiveBrokenReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
