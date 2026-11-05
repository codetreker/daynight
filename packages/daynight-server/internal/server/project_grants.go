package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func grantVersion(fields map[string]json.RawMessage) (*int64, error) {
	raw, present := fields["version"]
	if !present {
		return nil, invalidInput("version is required and must be null or a positive 64-bit integer")
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	version, err := membershipVersion(fields)
	if err != nil {
		return nil, err
	}
	return &version, nil
}

func grantActorAccess(access *model.ProjectAccess) *api.ProjectAccess {
	if access == nil {
		return nil
	}
	result := projectAccessResponse(*access)
	return &result
}

func (h *MembershipRoutes) setGrant(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	started := time.Now()
	w.Header().Set("Cache-Control", "no-store")
	logger, projectID, err := h.scoped(request, principal)
	if err == nil {
		_, err = queryValues(request)
	}
	var fields map[string]json.RawMessage
	if err == nil {
		fields, err = decodeObject(w, request, "version", "role", "expectedUserId")
	}
	var version *int64
	if err == nil {
		version, err = grantVersion(fields)
	}
	var role, expected string
	if err == nil {
		role, err = requiredString(fields, "role")
	}
	if err == nil {
		expected, err = requiredString(fields, "expectedUserId")
	}
	if err != nil {
		writeGrantError(w, request, logger, "prepare", started, err)
		return
	}
	result, err := h.memberships.SetGrant(request.Context(), principal, projectID, request.PathValue("userId"), service.SetProjectGrant{Version: version, Role: model.ProjectRole(role), ExpectedUserID: expected})
	if err != nil {
		writeGrantError(w, request, logger, "set", started, err)
		return
	}
	writeGrantJSON(w, request, logger, started, api.ProjectGrantResult{Grant: projectGrantResponse(result.Grant), ActorAccess: grantActorAccess(result.ActorAccess)})
}

func (h *MembershipRoutes) removeGrant(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	started := time.Now()
	w.Header().Set("Cache-Control", "no-store")
	logger, projectID, err := h.scoped(request, principal)
	if err == nil {
		_, err = queryValues(request)
	}
	var fields map[string]json.RawMessage
	if err == nil {
		fields, err = decodeObject(w, request, "version", "expectedUserId")
	}
	var version int64
	if err == nil {
		version, err = membershipVersion(fields)
	}
	var expected string
	if err == nil {
		expected, err = requiredString(fields, "expectedUserId")
	}
	if err != nil {
		writeGrantError(w, request, logger, "prepare", started, err)
		return
	}
	result, err := h.memberships.RemoveGrant(request.Context(), principal, projectID, request.PathValue("userId"), service.RemoveProjectMember{Version: version, ExpectedUserID: expected})
	if err != nil {
		writeGrantError(w, request, logger, "remove", started, err)
		return
	}
	writeGrantJSON(w, request, logger, started, api.RemoveProjectGrantResult{ProjectID: result.ProjectID, UserID: result.UserID, Deleted: true, ActorAccess: grantActorAccess(result.ActorAccess)})
}

func writeGrantError(w http.ResponseWriter, request *http.Request, logger *slog.Logger, phase string, started time.Time, err error) {
	logger = logger.With("duration_ms", time.Since(started).Milliseconds())
	var transaction *store.TransactionError
	if errors.As(err, &transaction) {
		phase = transaction.Phase
		if transaction.Outcome != store.TransactionNotCommitted {
			logger.ErrorContext(request.Context(), "project grant outcome unknown", "type", "operation_error", "component", "project_grant", "phase", phase, "outcome", "unknown", "cause", ErrorKind(err), "error_code", "write_outcome_unknown", "request_id", RequestID(request.Context()))
			writeJSON(w, request, logger, http.StatusServiceUnavailable, api.ErrorResponse{Error: api.Error{Code: "write_outcome_unknown", Message: "Project grant outcome is unknown. Read current state before making another change.", RequestID: RequestID(request.Context())}})
			return
		}
		if transaction.CleanupFailed {
			logger.ErrorContext(request.Context(), "project grant cleanup failed", "type", "operation_error", "component", "project_grant", "phase", phase, "outcome", "failed", "cause", "internal", "error_code", "internal_error", "request_id", RequestID(request.Context()))
			writeJSON(w, request, logger, http.StatusInternalServerError, api.ErrorResponse{Error: api.Error{Code: "internal_error", Message: "internal server error", RequestID: RequestID(request.Context())}})
			return
		}
	}
	outcome := "failed"
	if fault, ok := knownFault(err); ok && ErrorKind(err) == fault.Code {
		outcome = "refused"
	}
	writeError(w, request, logger.With("outcome", outcome), "project_grant", phase, err)
}

func writeGrantJSON(w http.ResponseWriter, request *http.Request, logger *slog.Logger, started time.Time, result any) {
	logger = logger.With("duration_ms", time.Since(started).Milliseconds())
	data, err := json.Marshal(result)
	if err != nil {
		LogFailure(logger.With("outcome", "unknown"), request.Context(), "project_grant", "response", err)
		writeJSON(w, request, logger, http.StatusServiceUnavailable, api.ErrorResponse{Error: api.Error{Code: "write_outcome_unknown", Message: "Project grant outcome is unknown. Read current state before making another change.", RequestID: RequestID(request.Context())}})
		return
	}
	data = append(data, '\n')
	if request.Context().Err() != nil {
		LogFailure(logger.With("outcome", "unknown"), request.Context(), "project_grant", "response", request.Context().Err())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	n, err := w.Write(data)
	if err == nil && n != len(data) {
		err = io.ErrShortWrite
	}
	if err != nil {
		LogFailure(logger.With("outcome", "unknown"), request.Context(), "project_grant", "response", err)
		return
	}
	logger.InfoContext(request.Context(), "project grant operation completed", "type", "resource", "component", "project_grant", "phase", "response", "outcome", "success", "request_id", RequestID(request.Context()))
}
