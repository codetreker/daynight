package httpx

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func quietLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestDecodeObjectContract(t *testing.T) {
	for _, tc := range []struct {
		name, contentType, body string
		valid                   bool
	}{
		{"valid", "application/json; charset=UTF-8", `{"name":"Alice"}`, true},
		{"missing content type", "", `{}`, false},
		{"wrong type", "text/json", `{}`, false},
		{"wrong charset", "application/json; charset=latin-1", `{}`, false},
		{"invalid utf8", "application/json", string([]byte{'{', 0xff, '}'}), false},
		{"oversize", "application/json", `{}` + strings.Repeat(" ", MaxJSONBody), false},
		{"unknown field", "application/json", `{"extra":1}`, false},
		{"duplicate field", "application/json", `{"name":"a","name":"b"}`, false},
		{"trailing object", "application/json", `{} {}`, false},
		{"non-object", "application/json", `[]`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", tc.contentType)
			fields, err := DecodeObject(httptest.NewRecorder(), req, "name")
			if tc.valid {
				if err != nil || string(fields["name"]) != `"Alice"` {
					t.Fatalf("fields=%v err=%v", fields, err)
				}
			} else {
				if tc.name == "oversize" {
					var bodyErr *BodyReadError
					if !errors.As(err, &bodyErr) || bodyErr.Status != http.StatusRequestEntityTooLarge {
						t.Fatalf("err=%v", err)
					}
					return
				}
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "invalid_input" {
					t.Fatalf("err=%v", err)
				}
			}
		})
	}
}

func TestFieldInputs(t *testing.T) {
	fields := map[string]json.RawMessage{"version": []byte(`9223372036854775807`), "name": []byte(`"Alice"`), "flag": []byte(`true`), "items": []byte(`["a","b"]`)}
	if v, err := VersionInput(fields); err != nil || v != 9223372036854775807 {
		t.Fatalf("version=%d %v", v, err)
	}
	if v, err := RequiredString(fields, "name"); err != nil || v != "Alice" {
		t.Fatalf("name=%q %v", v, err)
	}
	if v, err := OptionalBool(fields, "flag"); err != nil || v == nil || !*v {
		t.Fatalf("flag=%v %v", v, err)
	}
	if v, err := OptionalStrings(fields, "items"); err != nil || v == nil || !reflect.DeepEqual(*v, []string{"a", "b"}) {
		t.Fatalf("items=%v %v", v, err)
	}
	if v, err := OptionalString(fields, "missing"); err != nil || v != nil {
		t.Fatalf("absent string=%v %v", v, err)
	}
	if v, err := OptionalBool(fields, "missing"); err != nil || v != nil {
		t.Fatalf("absent bool=%v %v", v, err)
	}
	if v, err := OptionalStrings(fields, "missing"); err != nil || v != nil {
		t.Fatalf("absent array=%v %v", v, err)
	}
	if _, err := RequiredString(fields, "missing"); err == nil {
		t.Fatal("missing required string accepted")
	}
	for _, value := range []string{"null", "0", "-1", "1.5", "9223372036854775808", `"1"`} {
		if _, err := VersionInput(map[string]json.RawMessage{"version": []byte(value)}); err == nil {
			t.Fatalf("version %s accepted", value)
		}
	}
	for _, value := range []string{"null", "1", "true", `[]`} {
		f := map[string]json.RawMessage{"x": []byte(value)}
		if _, err := OptionalString(f, "x"); err == nil {
			t.Fatalf("string %s accepted", value)
		}
		if _, err := RequiredString(f, "x"); err == nil {
			t.Fatalf("required string %s accepted", value)
		}
	}
	for _, value := range []string{"null", "1", `"true"`} {
		if _, err := OptionalBool(map[string]json.RawMessage{"x": []byte(value)}, "x"); err == nil {
			t.Fatalf("bool %s accepted", value)
		}
	}
	for _, value := range []string{"null", "1", `"x"`, `[null]`, `[1]`} {
		if _, err := OptionalStrings(map[string]json.RawMessage{"x": []byte(value)}, "x"); err == nil {
			t.Fatalf("strings %s accepted", value)
		}
	}
}

func TestQueryAndPageRequest(t *testing.T) {
	for _, tc := range []struct {
		query  string
		limit  int
		cursor string
		valid  bool
	}{
		{"", 50, "", true}, {"limit=100&cursor=next", 100, "next", true}, {"limit=1", 1, "", true},
		{"limit=0", 0, "", false}, {"limit=101", 0, "", false}, {"limit=bad", 0, "", false},
		{"limit=1&limit=2", 0, "", false}, {"cursor=", 0, "", false}, {"unknown=x", 0, "", false}, {"cursor=%zz", 0, "", false},
	} {
		t.Run(tc.query, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/", nil)
			req.URL.RawQuery = tc.query
			p, err := PageRequest(req)
			if !tc.valid {
				if err == nil {
					t.Fatalf("accepted %s", tc.query)
				}
				return
			}
			if err != nil || p.Limit != tc.limit || (tc.cursor == "" && p.Cursor != nil) || (tc.cursor != "" && (p.Cursor == nil || *p.Cursor != tc.cursor)) {
				t.Fatalf("page=%+v err=%v", p, err)
			}
		})
	}
}

func TestWriteErrorMappingsAndDetails(t *testing.T) {
	for _, tc := range []struct {
		code   string
		status int
	}{
		{"unauthenticated", 401}, {"forbidden", 403}, {"invalid_input", 400}, {"payload_too_large", 413}, {"controller_offline", 503},
		{"unsupported_native_selection", 409}, {"unsupported_selection", 409}, {"unknown_default", 409}, {"stale_configuration", 409},
		{"capability_error", 503}, {"cleanup_unknown", 503}, {"io_error", 503}, {"offline", 503}, {"unsupported", 501}, {"timeout", 504}, {"cancelled", 409}, {"busy", 429}, {"limit_exceeded", 413}, {"invalid_cursor", 400}, {"invalid_path", 400},
		{"content_unavailable", 502}, {"rate_limited", 429}, {"capacity_exhausted", 503}, {"task_deleted", 410}, {"not_found", 404}, {"write_outcome_unknown", 503},
		{"configuration_not_initialized", 409}, {"active_worker_limit_exceeded", 409}, {"version_conflict", 409}, {"not_a_public_fault", 500},
	} {
		t.Run(tc.code, func(t *testing.T) {
			w := httptest.NewRecorder()
			req := httptest.NewRequest("GET", "/", nil)
			WriteError(w, req, quietLogger(), "test", "read", &model.Fault{Code: tc.code, Message: "safe"})
			wantCode := tc.code
			if tc.status == 500 {
				wantCode = "internal_error"
			}
			assertHTTPError(t, w, tc.status, wantCode)
			if (tc.code == "rate_limited" || tc.code == "capacity_exhausted") && w.Header().Get("Retry-After") != "60" {
				t.Fatalf("Retry-After=%q", w.Header().Get("Retry-After"))
			}
		})
	}
	for _, tc := range []struct {
		code   string
		status int
	}{{"identity_configuration", 503}, {"identity_timeout", 504}, {"identity_unavailable", 502}} {
		w := httptest.NewRecorder()
		WriteError(w, httptest.NewRequest("GET", "/", nil), quietLogger(), "auth", "providers", &model.IdentityProviderError{Code: tc.code})
		assertHTTPError(t, w, tc.status, tc.code)
	}
	for _, tc := range []struct {
		fault  *model.Fault
		detail string
	}{
		{&model.Fault{Code: "version_conflict", Message: "conflict", TaskIDs: []string{"task"}}, `{"taskIds":["task"]}`},
		{&model.Fault{Code: "steps_limit_exceeded", Message: "limit", StepsLimit: &model.StepsLimitDetails{EncodedBytes: 123, MaxEncodedBytes: 100}}, `{"encodedBytes":123,"maxEncodedBytes":100}`},
		{&model.Fault{Code: "graph_limit_exceeded", Message: "limit", GraphLimit: &model.GraphLimitDetails{NodeCount: 1, EdgeCount: 2, MaxNodes: 3, MaxEdges: 4}}, `{"nodeCount":1,"edgeCount":2,"maxNodes":3,"maxEdges":4}`},
	} {
		w := httptest.NewRecorder()
		WriteError(w, httptest.NewRequest("GET", "/", nil), quietLogger(), "test", "write", tc.fault)
		var response api.ErrorResponse
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || response.Error.Details == nil {
			t.Fatalf("missing details %s %v", w.Body, err)
		}
		got, err := json.Marshal(response.Error.Details)
		if err != nil || string(got) != tc.detail {
			t.Fatalf("details %s, want %s: %v", got, tc.detail, err)
		}
	}

	fault := &model.Fault{Code: "invalid_input", Message: "business"}
	w := httptest.NewRecorder()
	WriteError(w, httptest.NewRequest("GET", "/", nil), quietLogger(), "test", "write", &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: fault})
	assertHTTPError(t, w, 500, "internal_error")
}

type shortWriter struct {
	*httptest.ResponseRecorder
	err error
}

func (w *shortWriter) Write(b []byte) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	return len(b) - 1, nil
}

func TestResponseAndMutationFailures(t *testing.T) {
	logger := quietLogger()
	req := httptest.NewRequest("POST", "/", nil)
	w := httptest.NewRecorder()
	WriteCreated(w, req, logger, "/resource/1", map[string]int{"version": 1})
	if w.Code != 201 || w.Header().Get("Location") != "/resource/1" || w.Header().Get("Content-Type") != "application/json" || w.Body.String() != "{\"version\":1}\n" {
		t.Fatalf("created: %+v %s", w.Result(), w.Body)
	}
	w = httptest.NewRecorder()
	WriteMutationJSON(w, req, logger, "test", 201, map[string]int{"version": 1})
	if w.Code != 201 || w.Body.String() != "{\"version\":1}\n" {
		t.Fatalf("mutation: %d %s", w.Code, w.Body)
	}
	var encodingLogs bytes.Buffer
	w = httptest.NewRecorder()
	WriteJSON(w, req, slog.New(slog.NewJSONHandler(&encodingLogs, nil)), 200, make(chan int))
	if w.Code != 200 || w.Body.Len() != 0 || !strings.Contains(encodingLogs.String(), `"phase":"response"`) {
		t.Fatalf("encoding failure: %d %s %s", w.Code, w.Body, &encodingLogs)
	}
	w = httptest.NewRecorder()
	WriteMutationJSON(w, req, logger, "test", 201, make(chan int))
	assertHTTPError(t, w, 503, "write_outcome_unknown")
	for _, writeErr := range []error{nil, errors.New("private-write-failure")} {
		var logs bytes.Buffer
		responseLogger := slog.New(slog.NewJSONHandler(&logs, nil))
		w := &shortWriter{ResponseRecorder: httptest.NewRecorder(), err: writeErr}
		WriteMutationJSON(w, req, responseLogger, "test", 201, map[string]int{"version": 1})
		if w.Code != 201 || !strings.Contains(logs.String(), `"write_outcome":"unknown"`) || strings.Contains(logs.String(), "private-write-failure") {
			t.Fatalf("write response status %d, logs %s", w.Code, &logs)
		}
	}
	ctx, cancel := context.WithCancel(req.Context())
	cancel()
	canceled := req.WithContext(ctx)
	for _, operation := range []func(http.ResponseWriter){
		func(w http.ResponseWriter) { WriteJSON(w, canceled, logger, 200, nil) },
		func(w http.ResponseWriter) { WriteCreated(w, canceled, logger, "/x", nil) },
		func(w http.ResponseWriter) { WriteError(w, canceled, logger, "test", "write", errors.New("failure")) },
		func(w http.ResponseWriter) { WriteMutationJSON(w, canceled, logger, "test", 200, nil) },
		func(w http.ResponseWriter) { MethodNotAllowed(logger, "GET")(w, canceled) },
	} {
		w := httptest.NewRecorder()
		operation(w)
		if w.Body.Len() != 0 || len(w.Header()) != 0 {
			t.Fatalf("canceled response: %v %s", w.Header(), w.Body)
		}
	}
	w = httptest.NewRecorder()
	ResourceMethodNotAllowed(logger, "GET, HEAD")(w, req, model.Principal{UserID: "user"})
	assertHTTPError(t, w, 405, "method_not_allowed")
	if w.Header().Get("Allow") != "GET, HEAD" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(w.Header())
	}
	name := "name"
	ref := TeamRefResponse(model.TeamRef{ID: "id", Kind: "ordinary", Name: &name})
	if ref.ID != "id" || ref.Kind != "ordinary" || ref.Name == nil || *ref.Name != name {
		t.Fatalf("team=%+v", ref)
	}
}

func TestJSONBodyLimitAndReadFailure(t *testing.T) {
	for _, extra := range []int{0, 1} {
		body := `{}` + strings.Repeat(" ", MaxJSONBody-2+extra)
		r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		_, err := DecodeObject(w, r)
		if extra == 0 && err != nil {
			t.Fatalf("exact limit: %v", err)
		}
		if extra == 1 {
			var failure *BodyReadError
			if !errors.As(err, &failure) || failure.Status != http.StatusRequestEntityTooLarge {
				t.Fatalf("limit + 1: %v", err)
			}
			WriteError(w, r, quietLogger(), "test", "read", err)
			if w.Code != http.StatusRequestEntityTooLarge || strings.Contains(w.Body.String(), body) {
				t.Fatalf("response %d %s", w.Code, w.Body.String())
			}
		}
	}
}

func TestBodyFailureDoesNotHideTransactionOutcome(t *testing.T) {
	body := &BodyReadError{Cause: errors.New("read failed"), Status: http.StatusRequestEntityTooLarge, Code: "payload_too_large", Message: "request body exceeds its input limit"}
	timeout := &BodyReadError{Cause: errors.New("socket timeout"), Status: http.StatusRequestTimeout, Code: "request_timeout", Message: "request body read timed out"}
	for _, tc := range []struct {
		err    error
		status int
	}{
		{body, 413},
		{&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: body}, 413},
		{&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: body}, 500},
		{&store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: body}, 500},
		{errors.Join(body, errors.New("cleanup failed")), 500},
		{errors.Join(errors.Join(timeout, context.Canceled)), 408},
		{errors.Join(body, context.Canceled), 500},
		{errors.Join(timeout, context.Canceled, errors.New("cleanup failed")), 500},
	} {
		r := httptest.NewRequest(http.MethodPost, "/", nil)
		w := httptest.NewRecorder()
		WriteError(w, r, quietLogger(), "test", "read", tc.err)
		if w.Code != tc.status {
			t.Fatalf("%T: got %d want %d", tc.err, w.Code, tc.status)
		}
	}
}
