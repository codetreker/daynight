package tokenresponse

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

// Write delivers a confirmed token result without repeating its issuance after a lost response.
func Write(w http.ResponseWriter, r *http.Request, logger *slog.Logger, value any) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if logger == nil {
		logger = slog.Default()
	}
	responseUnknown := func(cause error) {
		httpx.LogFailure(logger.With("oauth_error_code", "outcome_unknown", "write_outcome", "unknown"), r.Context(), "oauth", "response", &model.Fault{Code: "write_outcome_unknown", Message: "The committed token response was not delivered.", Cause: cause})
	}
	data, err := json.Marshal(value)
	if err != nil {
		responseUnknown(err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("{\"error\":\"outcome_unknown\"}\n"))
		return
	}
	if err := r.Context().Err(); err != nil {
		responseUnknown(err)
		return
	}
	data = append(data, '\n')
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	written, err := w.Write(data)
	if err == nil && written != len(data) {
		err = io.ErrShortWrite
	}
	if err != nil {
		responseUnknown(err)
	}
}
