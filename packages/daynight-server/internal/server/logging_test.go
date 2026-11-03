package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"syscall"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestRequestLoggingAndRedaction(t *testing.T) {
	for _, id := range []string{"valid-ID.123", "", "\x1b[31msecret", "_invalid", strings.Repeat("a", 65)} {
		t.Run(fmt.Sprintf("%q", id), func(t *testing.T) {
			var output bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&output, nil))
			var actual string
			handler := RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				actual = RequestID(r.Context())
				LogFailure(logger, r.Context(), "store", "query", errors.New("postgres://user:password@secret SQL SELECT"))
				w.WriteHeader(http.StatusCreated)
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte("created"))
			}))
			request := httptest.NewRequest(http.MethodPost, "/?token=secret", strings.NewReader("password=secret"))
			request.Header.Set("X-Request-ID", id)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if !validRequestID(actual) || response.Header().Get("X-Request-ID") != actual || response.Code != http.StatusCreated {
				t.Fatalf("invalid response correlation: %s %+v", actual, response)
			}
			if id == "valid-ID.123" && actual != id {
				t.Fatal("valid request ID replaced")
			}
			if strings.Contains(output.String(), "secret") || strings.Contains(output.String(), "password") || strings.Contains(output.String(), "SELECT") {
				t.Fatalf("sensitive logs: %s", &output)
			}
			decoder := json.NewDecoder(&output)
			for range 2 {
				var entry map[string]any
				if err := decoder.Decode(&entry); err != nil || entry["request_id"] != actual {
					t.Fatalf("unlinked log: %+v %v", entry, err)
				}
			}
		})
	}
}

func TestResponseRecording(t *testing.T) {
	for _, handler := range []http.HandlerFunc{
		func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("body")) },
		func(w http.ResponseWriter, r *http.Request) {},
	} {
		var output bytes.Buffer
		response := httptest.NewRecorder()
		RequestLogging(slog.New(slog.NewJSONHandler(&output, nil)), handler).ServeHTTP(response, httptest.NewRequest("GET", "/", nil))
		if !strings.Contains(output.String(), `"status":200`) {
			t.Fatalf("missing implicit 200: %s", &output)
		}
	}
	underlying := httptest.NewRecorder()
	recorder := &responseRecorder{ResponseWriter: underlying}
	if recorder.Unwrap() != underlying {
		t.Fatal("response controller cannot reach underlying writer")
	}
	if RequestID(context.Background()) != "" {
		t.Fatal("unexpected request ID outside request")
	}
}

func TestRequestLogUsesRouteTemplate(t *testing.T) {
	var output bytes.Buffer
	mux := http.NewServeMux()
	mux.HandleFunc("GET /projects/{projectId}", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	RequestLogging(slog.New(slog.NewJSONHandler(&output, nil)), mux).ServeHTTP(
		httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/projects/path-secret?token=query-secret", nil),
	)
	var entry map[string]any
	if err := json.Unmarshal(output.Bytes(), &entry); err != nil {
		t.Fatal(err)
	}
	if entry["method"] != "GET" || entry["route"] != "GET /projects/{projectId}" || entry["status"] != float64(http.StatusNoContent) {
		t.Fatalf("missing method or route template: %+v", entry)
	}
	if strings.Contains(output.String(), "secret") {
		t.Fatalf("request targets leaked into logs: %s", &output)
	}
}

func TestPanicAbortsAndLogsSafeRequestID(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	secret := errors.New("postgres://password-secret@host SQL-secret")
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("X-Request-ID", "panic-request")
	func() {
		defer func() {
			if value := recover(); value != http.ErrAbortHandler {
				t.Fatalf("request did not signal HTTP abort: %v", value)
			}
		}()
		RequestLogging(logger, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic(secret) })).ServeHTTP(httptest.NewRecorder(), request)
	}()
	if strings.Contains(output.String(), "secret") || !strings.Contains(output.String(), `"request_id":"panic-request"`) || !strings.Contains(output.String(), `"cause":"panic"`) {
		t.Fatalf("unsafe or uncorrelated panic: %s", &output)
	}
}

func TestHTTPServerSurvivesSanitizedPanic(t *testing.T) {
	var output bytes.Buffer
	mux := http.NewServeMux()
	mux.HandleFunc("GET /panic", func(http.ResponseWriter, *http.Request) { panic("password-secret SQL-secret") })
	mux.HandleFunc("GET /healthy", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	server := httptest.NewUnstartedServer(RequestLogging(slog.New(slog.NewJSONHandler(&output, nil)), mux))
	var transportOutput bytes.Buffer
	server.Config.ErrorLog = log.New(&transportOutput, "", 0)
	server.Start()
	defer server.Close()
	client := server.Client()
	if response, err := client.Get(server.URL + "/panic"); err == nil {
		response.Body.Close()
		t.Fatal("panicking request returned a successful response")
	}
	response, err := client.Get(server.URL + "/healthy")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	server.Close()
	if response.StatusCode != http.StatusNoContent || strings.Contains(output.String(), "secret") || transportOutput.Len() != 0 {
		t.Fatalf("panic leaked or service remained unusable: %d %s %s", response.StatusCode, &output, &transportOutput)
	}
}

func TestErrorKind(t *testing.T) {
	for _, item := range []struct {
		err  error
		kind string
	}{
		{fmt.Errorf("wrapped: %w", context.Canceled), "canceled"},
		{context.DeadlineExceeded, "deadline"},
		{&pgconn.PgError{Message: "secret", Code: "42501"}, "database"},
		{&net.OpError{Op: "dial", Net: "tcp", Err: errors.New("secret")}, "network"},
		{fmt.Errorf("wrapped private address: %w", &net.OpError{Op: "listen", Net: "tcp", Err: fmt.Errorf("bind private address: %w", syscall.EADDRINUSE)}), "address_in_use"},
		{errors.New("secret"), "internal"},
	} {
		if kind := ErrorKind(item.err); kind != item.kind {
			t.Fatalf("got %s want %s", kind, item.kind)
		}
	}
}

func TestSafeFailureDiagnostics(t *testing.T) {
	for _, item := range []struct {
		err        error
		diagnostic string
	}{
		{&ConfigurationError{Field: "DAYNIGHT_LISTEN_ADDR", Rule: "must use a numeric loopback IP"}, "DAYNIGHT_LISTEN_ADDR must use a numeric loopback IP"},
		{&store.Error{Phase: "connect", Cause: errors.New("password-secret")}, "database connect failed"},
		{&runtimeError{phase: "listen", cause: errors.New("password-secret")}, "HTTP listen failed"},
	} {
		var output bytes.Buffer
		LogFailure(slog.New(slog.NewJSONHandler(&output, nil)), context.Background(), "server", "startup", item.err)
		if !strings.Contains(output.String(), item.diagnostic) || strings.Contains(output.String(), "password-secret") {
			t.Fatalf("unsafe or opaque diagnostic: %s", &output)
		}
	}
}

func TestListenerConflictDiagnosticsPreserveCategoryAndHideAddress(t *testing.T) {
	cause := &net.OpError{Op: "listen", Net: "tcp", Err: fmt.Errorf("private-address-secret: %w", syscall.EADDRINUSE)}
	failure := &runtimeError{phase: "listen", cause: cause}
	var output bytes.Buffer
	LogFailure(slog.New(slog.NewJSONHandler(&output, nil)), context.Background(), "server", "startup", failure)
	var entry map[string]any
	if err := json.Unmarshal(output.Bytes(), &entry); err != nil {
		t.Fatal(err)
	}
	if entry["cause"] != "address_in_use" || entry["phase"] != "startup" || entry["diagnostic"] != "HTTP listen failed" || strings.Contains(output.String(), "private-address-secret") || strings.Contains(output.String(), syscall.EADDRINUSE.Error()) {
		t.Fatalf("listener conflict lost phase/category or exposed raw error: %s", &output)
	}
}

func TestPropertyValidationHTTPErrorClassification(t *testing.T) {
	_, validation := taskproperties.Decode([]byte(`{"pullRequests":null}`))
	if validation == nil {
		t.Fatal("fixture did not produce a validation error")
	}
	for _, item := range []struct {
		name    string
		failure error
		status  int
		code    string
	}{
		{"direct", validation, http.StatusBadRequest, "invalid_input"},
		{"wrapped", fmt.Errorf("private-wrapper-secret: %w", validation), http.StatusBadRequest, "invalid_input"},
		{"stored", &store.Error{Phase: "read properties", Cause: validation}, http.StatusBadRequest, "invalid_input"},
		{"joined database failure", errors.Join(validation, &pgconn.PgError{Code: "08006", Message: "private-database-secret"}), http.StatusInternalServerError, "internal_error"},
		{"joined cleanup failure", errors.Join(validation, errors.New("private-cleanup-secret")), http.StatusInternalServerError, "internal_error"},
		{"wrapped joined failure", &store.Error{Phase: "rollback", Cause: errors.Join(validation, errors.New("private-rollback-secret"))}, http.StatusInternalServerError, "internal_error"},
	} {
		t.Run(item.name, func(t *testing.T) {
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			request.Header.Set("X-Request-ID", "project-test")
			RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				writeError(w, r, logger, "task_property", "get", item.failure)
			})).ServeHTTP(response, request)
			assertProjectError(t, response, item.status, item.code)
			if strings.Contains(response.Body.String(), "private-") || strings.Contains(logs.String(), "private-") {
				t.Fatalf("validation or infrastructure details leaked: %s %s", response.Body, &logs)
			}
		})
	}
}
