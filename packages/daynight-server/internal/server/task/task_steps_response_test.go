package task

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgconn"
)

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
		{&store.TransactionError{Phase: "commit", Cause: &pgconn.PgError{Code: "23505", Message: "database-message-sentinel", Detail: "database-detail-sentinel"}, Outcome: store.TransactionUnknown, CommitAttempted: true}, 500, "internal_error"},
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
