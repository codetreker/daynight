package usage

import (
	"bytes"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	app "github.com/codetreker/daynight/packages/daynight-server/internal/service/usage"
)

func TestStrictBoundedUsageBody(t *testing.T) {
	for _, tc := range []struct{ name, body, code string }{
		{"duplicate", `{"expectedRowVersion":"1","expectedRowVersion":"2"}`, "invalid_body"},
		{"unknown", `{"expectedRowVersion":"1","token":"secret"}`, "invalid_body"},
		{"number", `{"expectedRowVersion":1}`, "invalid_body"},
		{"surrogate", `{"expectedRowVersion":"\ud800"}`, "invalid_body"},
		{"depth", strings.Repeat("[", 65) + strings.Repeat("]", 65), "invalid_body"},
		{"trailing", `{"expectedRowVersion":"1"} {}`, "invalid_body"},
		{"utf8", string([]byte{'{', '"', 0xff, '"', '}'}), "invalid_body"},
		{"oversize", strings.Repeat(" ", 256*1024+1), "body_too_large"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/", strings.NewReader(tc.body))
			r.Header.Set("Content-Type", "application/json")
			var target struct {
				Expected string `json:"expectedRowVersion"`
			}
			_, err := parse(httptest.NewRecorder(), r, &target)
			var f *model.UsageFault
			if !errors.As(err, &f) || f.Code != tc.code {
				t.Fatal(err)
			}
		})
	}
	r := httptest.NewRequest("POST", "/", strings.NewReader(`{"expectedRowVersion":"9007199254740993"}`))
	r.Header.Set("Content-Type", "application/json")
	var target struct {
		Expected string `json:"expectedRowVersion"`
	}
	if _, err := parse(httptest.NewRecorder(), r, &target); err != nil || target.Expected != "9007199254740993" {
		t.Fatal(target, err)
	}
	if _, err := decodeEvent([]byte(`{"eventId":"x","kind":"execution_state","reasonCodes":[],"observedAt":"x","stateSequence":"1","collectionState":"collecting","capability":null,"nativeStartedAt":null,"nativeEndedAt":null,"seal":false,"metrics":{}}`)); err == nil {
		t.Fatal("mixed event shape")
	}
}

type rejectingAuth struct{ calls *int }

func (a rejectingAuth) Require(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { *a.calls++; w.WriteHeader(http.StatusUnauthorized) }
}

type fixedAuth struct{}

func (fixedAuth) Require(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { next(w, r, model.Principal{}) }
}
func TestUsageRoutesKeepOrdinaryAndGrantAuthenticationSeparate(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	service, err := app.New(nil, app.Options{CursorKey: []byte(strings.Repeat("k", 32))})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	calls := 0
	RegisterRoutes(mux, service, rejectingAuth{&calls}, logger)
	for _, route := range []string{"/api/usage/v1/capabilities", "/api/usage/v1/states/10000000-0000-4000-8000-000000000001", "/api/projects/10000000-0000-4000-8000-000000000001/tasks/10000000-0000-4000-8000-000000000002/usage/v1/summary", "/api/test-sessions/10000000-0000-4000-8000-000000000001/usage/v1/summary"} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("GET", route, nil))
		if w.Code != 401 {
			t.Fatal(route, w.Code)
		}
	}
	if calls != 4 {
		t.Fatal(calls)
	}
	r := httptest.NewRequest("POST", "/api/usage/v1/states/10000000-0000-4000-8000-000000000001/batches", strings.NewReader(`{"protocol":"daynight.usage.v1","batchId":"10000000-0000-4000-8000-000000000003","events":[]}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 401 || calls != 4 {
		t.Fatal(w.Code, calls)
	}
	mux = http.NewServeMux()
	RegisterRoutes(mux, service, fixedAuth{}, logger)
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/usage/v1/capabilities", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"writeEnabled":false`) || !strings.Contains(w.Body.String(), `"totalTokens":"unknown"`) {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestConditionalAuthorizationResponseAndSafeErrors(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("If-None-Match", `W/"hash"`)
	w := httptest.NewRecorder()
	if !conditional(w, r, "hash") || w.Code != 304 || w.Body.Len() != 0 {
		t.Fatal(w)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := handler{logger: logger}
	h.fail(w, r, &model.UsageFault{Code: "source_conflict", DiagnosticCommitted: true, RowVersion: "2", CurrentBodyHash: "hash"})
	if bytes.Contains(w.Body.Bytes(), []byte("token")) || !bytes.Contains(w.Body.Bytes(), []byte(`"diagnosticCommitted":true`)) {
		t.Fatal(w.Body.String())
	}
	for _, s := range []string{"Bearer short", "Basic " + strings.Repeat("x", 43), "Bearer " + strings.Repeat("x", 44)} {
		r.Header.Set("Authorization", s)
		if _, err := grant(r); err == nil {
			t.Fatal(s)
		}
	}
	r.Header.Set("Authorization", "Bearer "+strings.Repeat("x", 43))
	if _, err := grant(r); err != nil {
		t.Fatal(err)
	}
}
