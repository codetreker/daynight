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

func TestWriteJSONEncodesBeforeCommittingHeaders(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	w := httptest.NewRecorder()
	WriteCreated(w, req, quietLogger(), "/created", make(chan int))
	if w.Code != http.StatusInternalServerError || w.Header().Get("Location") != "" {
		t.Fatalf("status=%d location=%q", w.Code, w.Header().Get("Location"))
	}
	var response api.ErrorResponse
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || response.Error.Code != "internal_error" {
		t.Fatalf("body=%q err=%v", w.Body.String(), err)
	}

	w = httptest.NewRecorder()
	WriteJSON(w, req, quietLogger(), http.StatusOK, map[string]string{"value": "<"})
	if w.Code != http.StatusOK || w.Body.String() != "{\"value\":\"\\u003c\"}\n" {
		t.Fatalf("status=%d body=%q", w.Code, w.Body.String())
	}
}

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
				if tc.name == "invalid utf8" && fault.Message != "request body must be valid UTF-8" {
					t.Fatalf("invalid UTF-8 diagnostic: %q", fault.Message)
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
		{"unauthenticated", 401}, {"forbidden", 403}, {"invalid_input", 400}, {"invalid_tag_filter", 400}, {"payload_too_large", 413}, {"controller_offline", 503},
		{"unsupported_native_selection", 409}, {"unsupported_selection", 409}, {"unknown_default", 409}, {"stale_configuration", 409},
		{"capability_error", 503}, {"cleanup_unknown", 503}, {"io_error", 503}, {"offline", 503}, {"unsupported", 501}, {"timeout", 504}, {"cancelled", 409}, {"busy", 429}, {"limit_exceeded", 413}, {"invalid_cursor", 400}, {"invalid_path", 400},
		{"content_unavailable", 502}, {"rate_limited", 429}, {"capacity_exhausted", 503}, {"task_deleted", 410}, {"not_found", 404}, {"tag_not_found", 404}, {"write_outcome_unknown", 503},
		{"github_repository_mismatch", 409},
		{"archive_conflict", 409}, {"archive_incomplete", 409},
		{"invalid_image", 400}, {"image_integrity", 400}, {"image_decode_failed", 400}, {"component_unsupported", 409}, {"quota_exceeded", 409}, {"resource_in_use", 409}, {"capability_changed", 409}, {"media_outcome_unknown", 503}, {"resource_busy", 429},
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
	if w.Code != 500 || !strings.Contains(w.Body.String(), `"code":"internal_error"`) || !strings.Contains(encodingLogs.String(), `"phase":"response encoding"`) {
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
		{&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, CommitAttempted: true, Cause: body}, 500},
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

func TestWorkerConfigurationFaultClassificationPreservesTransactionFailures(t *testing.T) {
	logger := quietLogger()
	for _, code := range []string{"version_conflict", "configuration_not_initialized", "invalid_input"} {
		refusal := &model.Fault{Code: code, Message: "Configuration refusal."}
		for _, failure := range []*store.TransactionError{
			{Phase: "cleanup", Cause: errors.Join(refusal, errors.New("rollback failure")), Outcome: store.TransactionUnknown, CleanupFailed: true},
			{Phase: "commit", Cause: refusal, Outcome: store.TransactionUnknown, CommitAttempted: true},
			{Phase: "operation", Cause: refusal, Outcome: store.TransactionUnknown},
		} {
			if _, ok := KnownFault(failure); ok {
				t.Fatalf("operational failure classified as business refusal: %+v", failure)
			}
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPut, "/api/v1/me/workers/11111111-1111-4111-8111-111111111111/configuration", nil)
			WriteError(response, request, logger, "worker_configuration", "exchange", failure)
			var responseBody api.ErrorResponse
			if response.Code != http.StatusInternalServerError || response.Header().Get("Content-Type") != "application/json" || json.Unmarshal(response.Body.Bytes(), &responseBody) != nil {
				t.Fatalf("operational failure response: %d %s", response.Code, response.Body)
			}
			if responseBody.Error.Code != "internal_error" {
				t.Fatalf("operational failure exposed business code: %+v", responseBody)
			}
		}
		failure := &store.TransactionError{Phase: "operation", Cause: refusal, Outcome: store.TransactionNotCommitted}
		if fault, ok := KnownFault(failure); !ok || fault != refusal {
			t.Fatalf("rolled back refusal hidden: %+v %v", fault, ok)
		}
	}
}

func TestSessionContentFaultsRemainExplicitAndRecoverable(t *testing.T) {
	for code, status := range map[string]int{"controller_offline": http.StatusServiceUnavailable, "relay_instance_unavailable": http.StatusServiceUnavailable, "content_unavailable": http.StatusBadGateway} {
		t.Run(code, func(t *testing.T) {
			err := &model.Fault{Code: code, Message: "Connect the original controller to read local content."}
			if ErrorKind(err) != code {
				t.Fatal("content failure lost diagnostic category")
			}
			response := httptest.NewRecorder()
			WriteError(response, httptest.NewRequest(http.MethodGet, "/session/timeline", nil), quietLogger(), "session", "read", err)
			var body struct {
				Error struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if json.Unmarshal(response.Body.Bytes(), &body) != nil || response.Code != status || body.Error.Code != code || body.Error.Message != err.Message {
				t.Fatalf("fault response %d %s", response.Code, response.Body)
			}
		})
	}
}

type failingResponseWriter struct{ header http.Header }

func (w *failingResponseWriter) Header() http.Header { return w.header }
func (*failingResponseWriter) WriteHeader(int)       {}
func (*failingResponseWriter) Write([]byte) (int, error) {
	return 0, errors.New("private-connection-secret")
}

func TestHTTPErrorMappingAndWriteFailure(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	for _, err := range []error{
		errors.Join(model.ErrNotFound, errors.New("private-database-secret")),
		&model.Fault{Code: "unexpected", Message: "private-service-secret"},
	} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, "/", nil)
		request.Header.Set("X-Request-ID", "project-test")
		RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
			WriteError(w, request, logger, "project", "get", err)
		})).ServeHTTP(response, request)
		assertProjectCorrelation(t, response, http.StatusInternalServerError, "internal_error")
	}
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		WriteError(w, request, logger, "project", "get", &model.Fault{Code: "invalid_input", Message: "invalid references", TaskIDs: []string{"task-id"}})
	})).ServeHTTP(response, request)
	value := decodeProjectError(t, response, http.StatusBadRequest)
	if value.Error.Details == nil || len(value.Error.Details.TaskIDs) != 1 || value.Error.Details.TaskIDs[0] != "task-id" {
		t.Fatalf("missing error details: %+v", value)
	}
	WriteJSON(&failingResponseWriter{header: make(http.Header)}, request, logger, http.StatusOK, api.Project{})
	ctx, cancel := context.WithCancel(request.Context())
	cancel()
	canceled := httptest.NewRecorder()
	WriteJSON(canceled, request.WithContext(ctx), logger, http.StatusOK, api.Project{})
	if canceled.Body.Len() != 0 || len(canceled.Header()) != 0 {
		t.Fatalf("already canceled request wrote a response: %s %+v", canceled.Body, canceled.Header())
	}
	if strings.Contains(logs.String(), "secret") || !strings.Contains(logs.String(), `"phase":"response"`) {
		t.Fatalf("write failure not safely diagnosed: %s", &logs)
	}
}

func decodeProjectError(t *testing.T, response *httptest.ResponseRecorder, status int) api.ErrorResponse {
	t.Helper()
	var result api.ErrorResponse
	if response.Code != status || response.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("unexpected response: %d %s", response.Code, response.Body)
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}
func assertProjectCorrelation(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	result := decodeProjectError(t, response, status)
	if result.Error.Code != code || result.Error.Message == "" || result.Error.RequestID != response.Header().Get("X-Request-ID") || result.Error.RequestID != "project-test" {
		t.Fatalf("unexpected error correlation: %+v", result)
	}
}
