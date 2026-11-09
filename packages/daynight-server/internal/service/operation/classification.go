// Package operation classifies business errors and completion facts independently of transport.
package operation

import (
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func KnownFault(err error) (*model.Fault, bool) {
	if failed, _ := store.DatabaseErrorFacts(err); failed {
		return nil, false
	}
	unsafe := false
	var visit func(error)
	visit = func(current error) {
		if current == nil {
			return
		}
		if tx, ok := current.(*store.TransactionError); ok && (tx.Phase != "operation" || tx.CleanupFailed || tx.Outcome != store.TransactionNotCommitted) {
			unsafe = true
		}
		if tx, ok := current.(*store.ThreadTransactionError); ok && (tx.RollbackFailed || tx.OutcomeUnknown) {
			unsafe = true
		}
		if joined, ok := current.(interface{ Unwrap() []error }); ok {
			for _, child := range joined.Unwrap() {
				visit(child)
			}
		} else {
			visit(errors.Unwrap(current))
		}
	}
	visit(err)
	if unsafe {
		return nil, false
	}
	var botOperation *model.BotOperationError
	if errors.As(err, &botOperation) {
		return nil, false
	}
	var validation *taskproperties.ValidationError
	if errors.As(err, &validation) && onlyPropertyValidation(err) {
		return &model.Fault{Code: "invalid_input", Message: validation.Error(), Cause: err}, true
	}
	var fault *model.Fault
	if errors.As(err, &fault) {
		switch fault.Code {
		case "unsupported_native_selection", "unsupported_selection", "unknown_default", "stale_configuration", "capability_error", "cleanup_unknown", "io_error", "offline", "unsupported", "timeout", "cancelled", "busy", "limit_exceeded", "invalid_cursor", "invalid_path":
			return fault, true
		case "resource_busy", "list_changed", "configuration_not_initialized", "invalid_search_expression", "search_changed", "search_timeout", "transfer_conflict", "transfer_state_conflict", "capacity_unavailable", "resource_limit_exceeded", "monitoring_revision_conflict", "monitoring_sequence_stale", "monitoring_sample_conflict", "monitoring_state_lost", "monitoring_unavailable", "monitoring_write_outcome_unknown":
			return fault, true
		case "personal_team_immutable", "team_not_empty", "write_outcome_unknown", "step_id_conflict", "steps_limit_exceeded", "version_exhausted", "permission_denied", "stale_fence", "target_changed", "lease_expired", "input_busy", "automation_suspended", "unsupported_protocol", "unsupported_content_kind", "input_unknown", "recording_limit", "source_corrupt", "stop_unknown", "archive_pending", "invalid_payload", "controller_offline", "relay_instance_unavailable", "content_unavailable", "rate_limited", "capacity_exhausted", "unauthenticated", "forbidden", "last_admin", "identity_mismatch", "invitation_unavailable", "task_deleted", "invalid_input", "not_found", "path_conflict", "version_conflict", "invalid_transition", "claim_conflict", "active_worker_limit_exceeded", "active_worker_claims", "dependency_cycle", "dependency_unsatisfied", "session_conflict", "operation_conflict", "source_gap", "reconcile_required", "reset_required", "resource_conflict", "payload_too_large", "message_not_found", "clock_not_advanced", "message_outcome_unknown":
			return fault, true
		}
	}
	return nil, false
}

func onlyPropertyValidation(err error) bool {
	if _, ok := err.(*taskproperties.ValidationError); ok {
		return true
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		children := joined.Unwrap()
		if len(children) == 0 {
			return false
		}
		for _, child := range children {
			if !onlyPropertyValidation(child) {
				return false
			}
		}
		return true
	}
	if wrapped := errors.Unwrap(err); wrapped != nil {
		return onlyPropertyValidation(wrapped)
	}
	return false
}

// Facts describes only completion facts carried by the error. A zero Outcome
// means the error did not establish a transaction result.
type Facts struct {
	Outcome       store.TransactionOutcome
	Phase         string
	CleanupFailed bool
}

// CompletionFacts does not infer a write result from cancellation, an ordinary
// refusal, or a generic failure. A failed cleanup remains independent of the
// transaction outcome.
func CompletionFacts(err error) Facts {
	var result Facts
	var visit func(error)
	visit = func(current error) {
		if current == nil {
			return
		}
		var facts Facts
		switch failure := current.(type) {
		case interface {
			TransactionOutcome() store.TransactionOutcome
		}:
			facts.Outcome = failure.TransactionOutcome()
		case *store.TransactionError:
			facts = Facts{Outcome: failure.Outcome, Phase: failure.Phase, CleanupFailed: failure.CleanupFailed}
		case *store.ThreadTransactionError:
			facts = Facts{Phase: failure.Phase, CleanupFailed: failure.RollbackFailed}
			if failure.OutcomeUnknown {
				facts.Outcome = store.TransactionUnknown
			}
		}
		if facts.Outcome != "" {
			if result.Outcome == "" {
				result.Outcome = facts.Outcome
			} else if result.Outcome != facts.Outcome {
				result.Outcome = store.TransactionUnknown
			}
		}
		if result.Phase == "" {
			result.Phase = facts.Phase
		}
		result.CleanupFailed = result.CleanupFailed || facts.CleanupFailed
		if joined, ok := current.(interface{ Unwrap() []error }); ok {
			for _, child := range joined.Unwrap() {
				visit(child)
			}
		} else if wrapped := errors.Unwrap(current); wrapped != nil {
			visit(wrapped)
		}
	}
	visit(err)
	return result
}
