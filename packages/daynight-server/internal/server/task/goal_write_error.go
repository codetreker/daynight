package task

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func writeGoalOutcomeUnknown(w http.ResponseWriter, r *http.Request, logger *slog.Logger, phase string, err error) bool {
	var unknown *service.GoalWriteUnknown
	if !errors.As(err, &unknown) {
		return false
	}
	facts := operation.CompletionFacts(err)
	logger.ErrorContext(r.Context(), "Goal lifecycle outcome unknown", "type", "operation_error", "component", "task", "phase", phase,
		"cause", httpx.ErrorKind(err), "error_code", "write_outcome_unknown", "tx_outcome", "unknown", "cleanup_failed", facts.CleanupFailed, "request_id", httpx.RequestID(r.Context()))
	if r.Context().Err() == nil {
		httpx.WriteJSON(w, r, logger, http.StatusServiceUnavailable, api.ErrorResponse{Error: api.Error{Code: "write_outcome_unknown", Message: service.GoalWriteUnknownMessage, RequestID: httpx.RequestID(r.Context())}})
	}
	return true
}
