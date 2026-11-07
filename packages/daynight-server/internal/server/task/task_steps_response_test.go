package task

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func stepInputRequest(method string, body io.Reader) *http.Request {
	r := httptest.NewRequest(method, "/steps", body)
	r.SetPathValue("projectId", "11111111-1111-4111-8111-111111111111")
	r.SetPathValue("taskId", "22222222-2222-4222-8222-222222222222")
	r.SetPathValue("stepId", "12345678")
	r.Header.Set("Content-Type", "application/json")
	return r
}

func TestStepsBodyRejectionPreservesUncommittedOutcome(t *testing.T) {
	for _, tc := range []struct {
		name, method string
		handle       func(*taskStepsHandler, http.ResponseWriter, *http.Request, model.Principal)
	}{
		{"add", http.MethodPost, (*taskStepsHandler).add},
		{"change", http.MethodPatch, (*taskStepsHandler).change},
		{"status", http.MethodPut, (*taskStepsHandler).change},
		{"delete", http.MethodDelete, (*taskStepsHandler).delete},
		{"move", http.MethodPut, (*taskStepsHandler).move},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			h := &taskStepsHandler{logger: slog.New(slog.NewJSONHandler(&logs, nil))}
			request := stepInputRequest(tc.method, strings.NewReader(strings.Repeat("x", httpx.MaxJSONBody+1)))
			response := httptest.NewRecorder()
			tc.handle(h, response, request, model.Principal{UserID: "test"})
			if response.Code != http.StatusRequestEntityTooLarge || !strings.Contains(response.Body.String(), `"code":"payload_too_large"`) || !strings.Contains(logs.String(), `"tx_outcome":"not_committed"`) {
				t.Fatalf("status=%d body=%s logs=%s", response.Code, response.Body, logs.String())
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			request = stepInputRequest(tc.method, strings.NewReader(`{}`)).WithContext(ctx)
			response = httptest.NewRecorder()
			tc.handle(h, response, request, model.Principal{UserID: "test"})
			if response.Body.Len() != 0 {
				t.Fatalf("canceled operation wrote a response: %s", response.Body)
			}
		})
	}
}

func TestStepsSocketTimeoutRetainsUncommittedOutcome(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	h := &taskStepsHandler{logger: logger}
	served := make(chan struct{})
	handler := httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.SetPathValue("projectId", "11111111-1111-4111-8111-111111111111")
		r.SetPathValue("taskId", "22222222-2222-4222-8222-222222222222")
		h.add(w, r, model.Principal{UserID: "test"})
	}))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ServeHTTP(w, r)
		close(served)
	}))
	t.Cleanup(server.Close)
	conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(transport.JSONBodyReadTimeout + 5*time.Second))
	_, err = io.WriteString(conn, "POST /steps HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\nX-Request-ID: step-timeout\r\n\r\n{")
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil || response.StatusCode != http.StatusRequestTimeout || !response.Close || !strings.Contains(string(data), "step-timeout") {
		t.Fatalf("status=%d close=%v body=%q read=%v", response.StatusCode, response.Close, data, err)
	}
	select {
	case <-served:
	case <-time.After(5 * time.Second):
		t.Fatal("step handler did not finish")
	}
	if !strings.Contains(logs.String(), `"tx_outcome":"not_committed"`) {
		t.Fatalf("missing transaction outcome: %s", logs.String())
	}
}

type stepsFailureWriter struct{ *httptest.ResponseRecorder }

func (writer stepsFailureWriter) Write(data []byte) (int, error) { return len(data) - 1, nil }

func TestStepsResponseReportsWriteFailureAndCanceledOutput(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	request := httptest.NewRequest("GET", "/steps", nil)
	writeStepsJSON(stepsFailureWriter{httptest.NewRecorder()}, request, logger, 200, []byte("{}\n"))
	if !strings.Contains(logs.String(), `"response_outcome":"failed"`) {
		t.Fatal("short response write was reported as success")
	}
	ctx, cancel := context.WithCancel(request.Context())
	cancel()
	response := httptest.NewRecorder()
	writeStepsJSON(response, request.WithContext(ctx), logger, 200, []byte("{}\n"))
	if response.Body.Len() != 0 || response.Header().Get("Content-Type") != "" || !strings.Contains(logs.String(), `"response_outcome":"canceled_before_body"`) {
		t.Fatal("canceled response was written or treated as complete")
	}
	response = httptest.NewRecorder()
	writeStepsError(response, request, logger, "read", errors.Join(&model.Fault{Code: "not_found", Message: "Business refusal"}, errors.New("cleanup-secret-sentinel")))
	if response.Code != 500 || !strings.Contains(response.Body.String(), `"code":"internal_error"`) || strings.Contains(logs.String(), "cleanup-secret-sentinel") {
		t.Fatal("cleanup failure downgraded or disclosed")
	}
}

func TestStepsHTTPAddSafeFailureMetadataAndErrorDetails(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	request := httptest.NewRequest("POST", "/steps", nil)
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{&model.Fault{Code: "step_id_conflict", Message: "fault-message-sentinel"}, 409, "step_id_conflict"},
		{&model.Fault{Code: "version_conflict", Message: "fault-message-sentinel"}, 409, "version_conflict"},
		{&model.Fault{Code: "version_exhausted", Message: "fault-message-sentinel"}, 409, "version_exhausted"},
		{&model.Fault{Code: "steps_limit_exceeded", Message: "fault-message-sentinel", StepsLimit: &model.StepsLimitDetails{EncodedBytes: 67108865, MaxEncodedBytes: 67108864}}, 409, "steps_limit_exceeded"},
		{&store.TransactionError{Phase: "cleanup", Cause: &model.Fault{Code: "step_id_conflict", Message: "fault-message-sentinel"}, Outcome: store.TransactionNotCommitted, CleanupFailed: true}, 500, "internal_error"},
		{&store.TransactionError{Phase: "commit", Cause: &store.Error{Phase: "commit", DatabaseFailure: true, SQLState: "23505", Cause: errors.New("database-message-sentinel database-detail-sentinel")}, Outcome: store.TransactionUnknown, CommitAttempted: true}, 500, "internal_error"},
		{errors.Join(&model.Fault{Code: "not_found", Message: "fault-message-sentinel"}, errors.New("cleanup-sentinel")), 500, "internal_error"},
	} {
		response := httptest.NewRecorder()
		writeStepsError(response, request, logger, "commit", tc.err)
		var resource api.ErrorResponse
		if response.Code != tc.status {
			t.Fatalf("status %d: %s", response.Code, response.Body)
		}
		if err := json.Unmarshal(response.Body.Bytes(), &resource); err != nil {
			t.Fatal(err)
		}
		if resource.Error.Code != tc.code {
			t.Fatal(resource)
		}
		if tc.code == "steps_limit_exceeded" && (!reflect.DeepEqual(resource.Error.Details.EncodedBytes, new(int64(67108865))) || *resource.Error.Details.MaxEncodedBytes != 67108864) {
			t.Fatal(resource)
		}
	}
	for _, sentinel := range []string{"fault-message-sentinel", "database-message-sentinel", "database-detail-sentinel", "cleanup-sentinel"} {
		if strings.Contains(logs.String(), sentinel) {
			t.Fatal("arbitrary error text entered logs")
		}
	}
	if !strings.Contains(logs.String(), `"sqlstate":"23505"`) {
		t.Fatal("SQLSTATE cause missing")
	}
	for _, value := range []string{"", "secret", "23x05"} {
		if validSQLState(value) {
			t.Fatal("unsafe SQLSTATE accepted")
		}
	}
	for _, id := range []string{"plain", "x.r0", "x.rbad", "x.r18446744073709551616"} {
		if stepsReadKind(id) != "normal" {
			t.Fatal(id)
		}
	}
}
