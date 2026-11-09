package session_test

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func TestSessionArchiveRoutesPassBodiesAndMapUsecaseResults(t *testing.T) {
	f := archiveHTTPSetup(t)
	base := f.base + "/" + f.snapshot.SessionID + "/archive"
	for _, method := range []string{http.MethodPut, http.MethodPost} {
		calls := map[string]int{}
		if method == http.MethodPut {
			calls["TryReserveArchivePreflight"] = 1
		}
		f.Expect(calls)
		f.auth.ExpectCalls(1)
		request := httptest.NewRequest(method, base, strings.NewReader("{}"))
		authorizeResourceRequest(f.handler, request)
		request.Header.Set("Content-Type", "text/plain")
		response := httptest.NewRecorder()
		f.handler.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s non-JSON archive body accepted: %d", method, response.Code)
		}
		if response = f.Request(method, base+"?unknown=1", "{}", calls); response.Code != http.StatusBadRequest {
			t.Fatalf("%s archive query accepted: %d", method, response.Code)
		}
	}
	status := decodeResponse[struct {
		Archive sp.ArchiveStatus `json:"archive"`
	}](t, f.Request(http.MethodGet, base, "", map[string]int{"ArchiveStatus": 1}), http.StatusOK)
	if status.Archive.State != "unavailable" {
		t.Fatal(status)
	}
	update := sp.ArchiveUpdate{Fence: f.snapshot.Fence, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, State: "pending"}
	f.UpdateResult = sp.ArchiveStatus{State: "pending"}
	response := decodeResponse[struct {
		Archive sp.ArchiveStatus `json:"archive"`
	}](t, f.Request(http.MethodPost, base, jsonBody(t, update), map[string]int{"UpdateArchive": 1}), http.StatusOK)
	if response.Archive.State != "pending" || len(f.Updates) != 1 || !reflect.DeepEqual(f.Updates[0], update) {
		t.Fatal("archive update changed the supplied DTO or given response", response, f.Updates)
	}
	doc := sp.ArchiveDocument{Fence: f.snapshot.Fence, SchemaVersion: 1, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex", Entries: []sp.TimelineEntry{}, Resources: []sp.ArchiveResource{}}
	raw := jsonBody(t, doc)
	f.SetUploadResult(sp.ArchiveStatus{}, &model.Fault{Code: "session_conflict", Message: "Archive is not ready for finalization."})
	if r := f.Request(http.MethodPut, base, raw, map[string]int{"TryReserveArchivePreflight": 1, "BeginArchiveReserved": 1}); r.Code != http.StatusConflict {
		t.Fatal(r.Code, r.Body.String())
	}
	f.AssertBody(t, []byte(raw))
	f.AssertReleased(t)
	size := strconv.Itoa(len(raw))
	digest := strings.Repeat("a", 64)
	f.SetUploadResult(sp.ArchiveStatus{State: "ready", SHA256: &digest, ByteLength: &size}, nil)
	status = decodeResponse[struct {
		Archive sp.ArchiveStatus `json:"archive"`
	}](t, f.Request(http.MethodPut, base, raw, map[string]int{"TryReserveArchivePreflight": 1, "BeginArchiveReserved": 1}), http.StatusOK)
	if !reflect.DeepEqual(status.Archive, f.UploadResult) {
		t.Fatal("archive upload changed the given result", status)
	}
	f.AssertBody(t, []byte(raw))
	f.AssertReleased(t)
	f.SetNativeContent([]byte(raw))
	got := f.Request(http.MethodGet, base+"/content", "", map[string]int{"TryReserveArchivePreflight": 1, "ArchiveContentReserved": 1})
	expected := `{"archive":` + raw + `}`
	if got.Code != http.StatusOK || got.Body.String() != expected {
		t.Fatal("native archive envelope changed its given bytes", got.Code, got.Body.String())
	}
	f.AssertReleased(t)
	for _, path := range []string{base, base + "/content"} {
		for _, method := range []string{http.MethodHead, http.MethodDelete} {
			if r := f.Request(method, path, "", nil); r.Code != http.StatusMethodNotAllowed {
				t.Fatal(method, r.Code)
			}
		}
		calls := map[string]int{}
		if path == base+"/content" {
			calls["TryReserveArchivePreflight"] = 1
		}
		if r := f.Request(http.MethodGet, path+"?unknown=1", "", calls); r.Code != http.StatusBadRequest {
			t.Fatal(r.Code)
		}
		f.Expect(calls)
		f.auth.ExpectCalls(0)
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		f.handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatal(rec.Code)
		}
	}
	f.SetUploadResult(sp.ArchiveStatus{}, &model.Fault{Code: "invalid_input", Message: "Invalid archive."})
	if r := f.Request(http.MethodPut, base, "{}", map[string]int{"TryReserveArchivePreflight": 1, "BeginArchiveReserved": 1}); r.Code != http.StatusBadRequest {
		t.Fatal(r.Code, r.Body.String())
	}
	f.AssertBody(t, []byte("{}"))
	if r := f.Request(http.MethodPost, base, "{}", nil); r.Code != http.StatusBadRequest {
		t.Fatal(r.Code, r.Body.String())
	}
}

func TestSessionArchiveRoutesPreserveFinalizationAndReadRefusals(t *testing.T) {
	f := archiveHTTPSetup(t)
	base := f.base + "/" + f.snapshot.SessionID + "/archive"
	f.Status = sp.ArchiveStatus{State: "unavailable"}
	status := decodeResponse[struct {
		Archive sp.ArchiveStatus `json:"archive"`
	}](t, f.Request(http.MethodGet, base, "", map[string]int{"ArchiveStatus": 1}), http.StatusOK)
	if status.Archive.State != "unavailable" {
		t.Fatal(status)
	}
	update := sp.ArchiveUpdate{Fence: f.snapshot.Fence, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, State: "pending"}
	decodeResponse[map[string]any](t, f.Request(http.MethodPost, base, jsonBody(t, update), map[string]int{"UpdateArchive": 1}), http.StatusOK)
	doc := sp.ArchiveDocument{Fence: f.snapshot.Fence, SchemaVersion: 1, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex", Entries: []sp.TimelineEntry{}, Resources: []sp.ArchiveResource{}}
	raw := jsonBody(t, doc)
	size := strconv.Itoa(len(raw))
	digest := strings.Repeat("b", 64)
	ready := sp.ArchiveStatus{State: "ready", SHA256: &digest, ByteLength: &size}
	f.SetUploadResult(ready, nil)
	result := decodeResponse[struct {
		Archive sp.ArchiveStatus `json:"archive"`
	}](t, f.Request(http.MethodPut, base, raw, map[string]int{"TryReserveArchivePreflight": 1, "BeginArchiveReserved": 1}), http.StatusOK)
	if !reflect.DeepEqual(result.Archive, ready) {
		t.Fatal("finalization response changed its usecase result", result)
	}
	f.AssertBody(t, []byte(raw))
	f.Status = ready
	status = decodeResponse[struct {
		Archive sp.ArchiveStatus `json:"archive"`
	}](t, f.Request(http.MethodGet, base, "", map[string]int{"ArchiveStatus": 1}), http.StatusOK)
	if !reflect.DeepEqual(status.Archive, ready) {
		t.Fatal(status)
	}
	f.ContentError = &model.Fault{Code: "not_found", Message: "Session was not found."}
	assertProjectError(t, f.Request(http.MethodGet, base+"/content", "", map[string]int{"TryReserveArchivePreflight": 1, "ArchiveContentReserved": 1}), http.StatusNotFound, "not_found")
	assertProjectError(t, f.Request(http.MethodGet, f.base+"/current", "", map[string]int{"Current": 1}), http.StatusNotFound, "not_found")
}
