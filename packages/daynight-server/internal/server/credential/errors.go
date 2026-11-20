package credential

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
)

// WriteOperationError preserves completion and cleanup facts without exposing input.
func WriteOperationError(w http.ResponseWriter, r *http.Request, logger *slog.Logger, component, phase string, err error, unknown bool) {
	facts := operation.CompletionFacts(err)
	if unknown || facts.Outcome == store.TransactionUnknown || facts.CleanupFailed || facts.Outcome == store.TransactionCommitted || facts.Phase != "" && facts.Phase != "operation" {
		status, code, message := http.StatusInternalServerError, "internal_error", "The request could not be completed."
		if unknown || facts.Outcome == store.TransactionUnknown {
			status, code, message = http.StatusServiceUnavailable, "write_outcome_unknown", "The write outcome is unknown. Read the current resource before deciding on another operation."
		}
		diagnosticPhase := facts.Phase
		if diagnosticPhase == "" {
			diagnosticPhase = phase
		}
		if facts.CleanupFailed {
			diagnosticPhase = "cleanup"
		}
		outcome := facts.Outcome
		if unknown {
			outcome = store.TransactionUnknown
		}
		logger = logger.With("write_outcome", string(outcome), "transaction_phase", facts.Phase, "cleanup_failed", facts.CleanupFailed)
		httpx.LogFailure(logger, r.Context(), component, diagnosticPhase, &model.Fault{Code: code, Message: message, Cause: err})
		httpx.WriteJSON(w, r, logger, status, api.ErrorResponse{Error: api.Error{Code: code, Message: message, RequestID: httpx.RequestID(r.Context())}})
		return
	}
	databaseFailure, state := store.DatabaseErrorFacts(err)
	_, known := httpx.KnownFault(err)
	if r.Context().Err() == nil && (!databaseFailure || state == "") && !known && (facts.Outcome == "" || facts.Outcome == store.TransactionNotCommitted) && errors.Is(err, context.DeadlineExceeded) {
		err = &model.Fault{Code: "timeout", Message: "The credential operation timed out."}
	}
	if !databaseFailure && errors.Is(err, model.ErrNotFound) {
		err = &model.Fault{Code: "not_found", Message: "Credential not found."}
	}
	httpx.WriteError(w, r, logger, component, phase, err)
}

// WriteReadError classifies bounded admission and read timeouts without changing legacy APIs.
func WriteReadError(w http.ResponseWriter, r *http.Request, logger *slog.Logger, component, phase string, err error) {
	facts := operation.CompletionFacts(err)
	failed, state := store.DatabaseErrorFacts(err)
	_, known := httpx.KnownFault(err)
	if r.Context().Err() == nil && (!failed || state == "") && !known && !facts.CleanupFailed && (facts.Phase == "" || facts.Phase == "operation") && errors.Is(err, context.DeadlineExceeded) {
		err = &model.Fault{Code: "timeout", Message: "The credential operation timed out."}
	}
	httpx.WriteError(w, r, logger, component, phase, err)
}
