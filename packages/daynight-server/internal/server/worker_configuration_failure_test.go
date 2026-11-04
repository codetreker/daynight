package server

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func TestWorkerConfigurationFaultClassificationPreservesTransactionFailures(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	for _, code := range []string{"version_conflict", "configuration_not_initialized", "invalid_input"} {
		refusal := &service.Fault{Code: code, Message: "Configuration refusal."}
		for _, failure := range []*store.TransactionError{
			{Phase: "cleanup", Cause: errors.Join(refusal, errors.New("rollback failure")), Outcome: store.TransactionUnknown, CleanupFailed: true},
			{Phase: "commit", Cause: refusal, Outcome: store.TransactionUnknown, CommitAttempted: true},
			{Phase: "operation", Cause: refusal, Outcome: store.TransactionUnknown},
		} {
			if _, ok := knownFault(failure); ok {
				t.Fatalf("operational failure classified as business refusal: %+v", failure)
			}
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPut, "/api/v1/me/workers/11111111-1111-4111-8111-111111111111/configuration", nil)
			writeError(response, request, logger, "worker_configuration", "exchange", failure)
			responseBody := decodeResponse[api.ErrorResponse](t, response, http.StatusInternalServerError)
			if responseBody.Error.Code != "internal_error" {
				t.Fatalf("operational failure exposed business code: %+v", responseBody)
			}
		}
		failure := &store.TransactionError{Phase: "operation", Cause: refusal, Outcome: store.TransactionNotCommitted}
		if fault, ok := knownFault(failure); !ok || fault != refusal {
			t.Fatalf("rolled back refusal hidden: %+v %v", fault, ok)
		}
	}
}
