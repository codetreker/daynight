package httpx

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func WriteMutationJSON(w http.ResponseWriter, r *http.Request, logger *slog.Logger, component string, status int, value any) {
	responseLogger := logger.With(component+"_error_code", "write_outcome_unknown", "write_outcome", "unknown")
	data, err := json.Marshal(value)
	if err != nil {
		fault := &model.Fault{Code: "write_outcome_unknown", Message: "The committed write response was not delivered.", Cause: err}
		LogFailure(responseLogger, r.Context(), component, "response", fault)
		WriteJSON(w, r, logger, http.StatusServiceUnavailable, api.ErrorResponse{Error: api.Error{Code: fault.Code, Message: fault.Message, RequestID: RequestID(r.Context())}})
		return
	}
	if r.Context().Err() != nil {
		LogFailure(responseLogger, r.Context(), component, "response", &model.Fault{Code: "write_outcome_unknown", Message: "The committed write response was not delivered.", Cause: r.Context().Err()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	data = append(data, '\n')
	written, err := w.Write(data)
	if err == nil && written != len(data) {
		err = io.ErrShortWrite
	}
	if err != nil {
		LogFailure(responseLogger, r.Context(), component, "response", &model.Fault{Code: "write_outcome_unknown", Message: "The committed write response was not delivered.", Cause: err})
		return
	}
	logger.InfoContext(r.Context(), "write response", "type", "resource", "component", component, "phase", "response", "status", status, "written_bytes", written, "request_id", RequestID(r.Context()))
}
