package session_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func TestSessionArchiveRoutes(t *testing.T) {
	f := archiveHTTPSetup(t)
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
		if response = f.Request(method, base+"?unknown=1", "{}"); response.Code != http.StatusBadRequest {
			t.Fatalf("%s archive query accepted: %d", method, response.Code)
		}
	}
	f.Declare("initial-status", archiveScopeCounts(true, map[string]int{"SessionArchive": 1}), false)
	status := decodeResponse[struct {
		Archive sp.ArchiveStatus `json:"archive"`
	}](t, f.Request(http.MethodGet, base, "", "initial-status"), http.StatusOK)
	if status.Archive.State != "unavailable" {
		t.Fatal(status)
	}
	update := sp.ArchiveUpdate{Fence: f.snapshot.Fence, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, State: "pending"}
	f.Declare("pending-status", archiveScopeCounts(true, map[string]int{"SessionArchive": 1, "SetSessionArchiveState": 1}), false)
	decodeResponse[map[string]any](t, f.Request(http.MethodPost, base, jsonBody(t, update), "pending-status"), http.StatusOK)
	f.AcceptState(t, "pending")
	doc := sp.ArchiveDocument{Fence: f.snapshot.Fence, SchemaVersion: 1, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex", Entries: []sp.TimelineEntry{}, Resources: []sp.ArchiveResource{}}
	raw := jsonBody(t, doc)
	f.Declare("active-preflight", archivePreflightCounts(), false)
	f.Declare("active-refusal", archiveScopeCounts(true, nil), false)
	if r := f.Request(http.MethodPut, base, raw, "active-preflight", "active-refusal"); r.Code != http.StatusConflict {
		t.Fatal(r.Code, r.Body.String())
	}
	f.UseEndedTaskInput()
	f.Declare("upload-preflight", archivePreflightCounts(), false)
	f.Declare("upload", archiveScopeCounts(true, map[string]int{"SessionArchive": 1, "SetSessionArchiveReady": 1}), false)
	status = decodeResponse[struct {
		Archive sp.ArchiveStatus `json:"archive"`
	}](t, f.Request(http.MethodPut, base, raw, "upload-preflight", "upload"), http.StatusOK)
	if status.Archive.State != "ready" {
		t.Fatal(status)
	}
	f.AcceptReady(t, []byte(raw))
	f.Declare("content-preflight", archivePreflightCounts(), false)
	f.Declare("content", archiveScopeCounts(false, map[string]int{"SessionArchive": 1}), false)
	got := decodeResponse[map[string]any](t, f.Request(http.MethodGet, base+"/content", "", "content-preflight", "content"), http.StatusOK)
	if got["archive"].(map[string]any)["sessionId"] != f.snapshot.SessionID {
		t.Fatal(got)
	}
	for _, path := range []string{base, base + "/content"} {
		for _, method := range []string{http.MethodHead, http.MethodDelete} {
			if r := f.Request(method, path, ""); r.Code != http.StatusMethodNotAllowed {
				t.Fatal(method, r.Code)
			}
		}
		if r := f.Request(http.MethodGet, path+"?unknown=1", ""); r.Code != http.StatusBadRequest {
			t.Fatal(r.Code)
		}
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		f.handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatal(rec.Code)
		}
	}
	f.Declare("invalid-upload-preflight", archivePreflightCounts(), false)
	if r := f.Request(http.MethodPut, base, "{}", "invalid-upload-preflight"); r.Code != http.StatusBadRequest {
		t.Fatal(r.Code, r.Body.String())
	}
	if r := f.Request(http.MethodPost, base, "{}"); r.Code != http.StatusBadRequest {
		t.Fatal(r.Code, r.Body.String())
	}
}

func TestDeletedTaskArchiveRoutesAllowFinalizationOnly(t *testing.T) {
	f := archiveHTTPSetup(t)
	base := f.base + "/" + f.snapshot.SessionID + "/archive"
	f.UseEndedTaskInput()
	f.UseDeletedTaskInput()
	f.Declare("deleted-status", archiveScopeCounts(true, map[string]int{"SessionArchive": 1}), false)
	status := decodeResponse[struct {
		Archive sp.ArchiveStatus `json:"archive"`
	}](t, f.Request(http.MethodGet, base, "", "deleted-status"), http.StatusOK)
	if status.Archive.State != "unavailable" {
		t.Fatal(status)
	}
	update := sp.ArchiveUpdate{Fence: f.snapshot.Fence, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, State: "pending"}
	f.Declare("deleted-pending", archiveScopeCounts(true, map[string]int{"SessionArchive": 1, "SetSessionArchiveState": 1}), false)
	decodeResponse[map[string]any](t, f.Request(http.MethodPost, base, jsonBody(t, update), "deleted-pending"), http.StatusOK)
	f.AcceptState(t, "pending")
	doc := sp.ArchiveDocument{Fence: f.snapshot.Fence, SchemaVersion: 1, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex", Entries: []sp.TimelineEntry{}, Resources: []sp.ArchiveResource{}}
	raw := jsonBody(t, doc)
	f.Declare("deleted-upload-preflight", archivePreflightCounts(), false)
	f.Declare("deleted-upload", archiveScopeCounts(true, map[string]int{"SessionArchive": 1, "SetSessionArchiveReady": 1}), false)
	decodeResponse[map[string]any](t, f.Request(http.MethodPut, base, raw, "deleted-upload-preflight", "deleted-upload"), http.StatusOK)
	f.AcceptReady(t, []byte(raw))
	f.Declare("deleted-ready-status", archiveScopeCounts(true, map[string]int{"SessionArchive": 1}), false)
	status = decodeResponse[struct {
		Archive sp.ArchiveStatus `json:"archive"`
	}](t, f.Request(http.MethodGet, base, "", "deleted-ready-status"), http.StatusOK)
	if status.Archive.State != "ready" || status.Archive.SHA256 == nil {
		t.Fatal(status)
	}
	f.Declare("deleted-content-preflight", archivePreflightCounts(), false)
	assertProjectError(t, f.Request(http.MethodGet, base+"/content", "", "deleted-content-preflight"), http.StatusNotFound, "not_found")
	f.Declare("deleted-current", map[string]int{"LockTask": 1}, false)
	assertProjectError(t, f.Request(http.MethodGet, f.base+"/current", "", "deleted-current"), http.StatusNotFound, "not_found")
}
