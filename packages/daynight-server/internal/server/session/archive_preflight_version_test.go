package session_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
)

func TestArchivePreflightVersionHeader(t *testing.T) {
	f := archiveHTTPSetup(t)
	var failure error = &model.Fault{Code: "resource_busy", Message: "Archive admission is busy."}
	f.backend.Funcs.TryReserveArchivePreflight = func() (io.Closer, error) { return nil, failure }
	file := "11111111-1111-4111-8111-111111111111"
	for _, root := range []string{f.base + "/" + f.snapshot.SessionID, "/api/v1/test-sessions/" + f.snapshot.SessionID} {
		base := root + "/archive"
		for _, tc := range []struct {
			method, path, protocol, requested string
			wantHeader                        bool
		}{
			{http.MethodPost, base + "/prepare", "", "", true},
			{http.MethodPost, base + "/source-tail", "", "", true},
			{http.MethodPost, base + "/seal", "", "", true},
			{http.MethodPut, base + "/content", "", "", true},
			{http.MethodPut, base + "/prepare/history/" + file, "", "", true},
			{http.MethodPut, base + "/files/" + file, "", "", true},
			{http.MethodGet, base + "/files/" + file, "", "", true},
			{http.MethodPut, root + "/image-history-ledger/" + file, "", "", true},
			{http.MethodGet, root + "/image-history-ledger/" + file + "/status", "", "", true},
			{http.MethodGet, base + "/content", "", "1", true},
			{http.MethodGet, base + "/content", "", "", false},
			{http.MethodPut, base, "", "1", false},
			{http.MethodGet, base + "/content", "daynight.session.v2", "1", false},
			{http.MethodGet, base + "/files/" + file, "daynight.session.v2", "1", false},
			{http.MethodGet, base + "/files/" + file, "unknown", "1", false},
		} {
			f.Expect(map[string]int{"TryReserveArchivePreflight": 1})
			f.auth.ExpectCalls(0)
			r := httptest.NewRequest(tc.method, tc.path, strings.NewReader("{}"))
			r.Header.Set("X-Request-ID", "project-test")
			if tc.protocol != "" {
				r.Header.Set("Daynight-Session-Protocol", tc.protocol)
			}
			if tc.requested != "" {
				r.Header.Set("Daynight-Task-Body-History-Version", tc.requested)
			}
			w := httptest.NewRecorder()
			f.handler.ServeHTTP(w, r)
			assertProjectError(t, w, http.StatusTooManyRequests, "resource_busy")
			if got := w.Header().Get("Daynight-Task-Body-History-Version"); (got == "1") != tc.wantHeader {
				t.Errorf("%s %s protocol=%q requested=%q: version=%q", tc.method, tc.path, tc.protocol, tc.requested, got)
			}
		}
	}
	failure = errors.New("unavailable")
	f.Expect(map[string]int{"TryReserveArchivePreflight": 1})
	f.auth.ExpectCalls(0)
	r := httptest.NewRequest(http.MethodPost, f.base+"/"+f.snapshot.SessionID+"/archive/prepare", nil)
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if w.Code != http.StatusInternalServerError || w.Header().Get("Daynight-Task-Body-History-Version") != "" {
		t.Fatalf("non-capacity error: %d %v", w.Code, w.Header())
	}
}

func TestArchiveCapacityDiagnostics(t *testing.T) {
	f := archiveHTTPSetup(t)
	var logs bytes.Buffer
	h := newResourceTestHandler(t, f.backend, f.auth, f.handler.principal, &logs)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := h.application.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	var failure error
	f.backend.Funcs.TryReserveArchivePreflight = func() (io.Closer, error) { return nil, failure }
	for _, stage := range []string{"preflight_full", "instance_full", "owner_busy"} {
		logs.Reset()
		failure = &sessioncore.ArchiveCapacityError{Stage: stage, Cause: &model.Fault{Code: "resource_busy", Message: "Session archive capacity is unavailable."}}
		f.Expect(map[string]int{"TryReserveArchivePreflight": 1})
		f.auth.ExpectCalls(0)
		r := httptest.NewRequest(http.MethodPost, f.base+"/"+f.snapshot.SessionID+"/archive/prepare", nil)
		r.Header.Set("X-Request-ID", "project-test")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		assertProjectError(t, w, http.StatusTooManyRequests, "resource_busy")
		for _, want := range []string{`"component":"session"`, `"phase":"` + stage + `"`, `"cause":"resource_busy"`, `"error_code":"resource_busy"`, `"request_id":"project-test"`} {
			if !strings.Contains(logs.String(), want) {
				t.Errorf("%s: missing %s in %s", stage, want, logs.String())
			}
		}
	}
}
