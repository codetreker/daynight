package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
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

func TestDeletedTaskArchiveRoutesAllowFinalizationOnly(t *testing.T) {
	f := sessionHTTPSetup(t)
	base := f.base + "/" + f.snapshot.SessionID + "/archive"
	ended := decodeResponse[api.Task](t, projectRequest(f.handler, "PUT", taskPath(f.task)+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: f.task.Version, Status: "done", ClaimID: &f.snapshot.ClaimID})), http.StatusOK)
	response := projectRequest(f.handler, "DELETE", taskPath(ended), jsonBody(t, api.TaskDeleteRequest{Version: ended.Version}))
	if response.Code != http.StatusNoContent {
		t.Fatal(response.Code, response.Body.String())
	}
	status := decodeResponse[struct {
		Archive sp.ArchiveStatus `json:"archive"`
	}](t, projectRequest(f.handler, "GET", base, ""), http.StatusOK)
	if status.Archive.State != "unavailable" {
		t.Fatal(status)
	}
	update := sp.ArchiveUpdate{Fence: f.snapshot.Fence, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, State: "pending"}
	decodeResponse[map[string]any](t, projectRequest(f.handler, "POST", base, jsonBody(t, update)), http.StatusOK)
	doc := sp.ArchiveDocument{Fence: f.snapshot.Fence, SchemaVersion: 1, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex", Entries: []sp.TimelineEntry{}, Resources: []sp.ArchiveResource{}}
	decodeResponse[map[string]any](t, projectRequest(f.handler, "PUT", base, jsonBody(t, doc)), http.StatusOK)
	status = decodeResponse[struct {
		Archive sp.ArchiveStatus `json:"archive"`
	}](t, projectRequest(f.handler, "GET", base, ""), http.StatusOK)
	if status.Archive.State != "ready" || status.Archive.SHA256 == nil {
		t.Fatal(status)
	}
	assertProjectError(t, projectRequest(f.handler, "GET", taskPath(ended), ""), http.StatusGone, "task_deleted")
	for _, path := range []string{base + "/content", f.base + "/current"} {
		assertProjectError(t, projectRequest(f.handler, "GET", path, ""), http.StatusNotFound, "not_found")
	}
}
