package server

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
)

func transferNested(fields map[string]json.RawMessage, key string, allowed ...string) (map[string]json.RawMessage, error) {
	value, err := jsonobject.Decode(fields[key], key, allowed...)
	if err != nil {
		return nil, httpx.InvalidInput(err.Error())
	}
	return value, nil
}

func transferInput(w http.ResponseWriter, r *http.Request) (service.TransferInput, error) {
	var input service.TransferInput
	if _, err := httpx.QueryValues(r); err != nil {
		return input, err
	}
	fields, err := httpx.DecodeObject(w, r, "ownership", "targetTeam", "expectedUserId")
	if err != nil {
		return input, err
	}
	owner, err := transferNested(fields, "ownership", "teamId", "version")
	if err != nil {
		return input, err
	}
	if input.Ownership.TeamID, err = httpx.RequiredString(owner, "teamId"); err != nil {
		return input, err
	}
	if input.Ownership.Version, err = httpx.VersionInput(owner); err != nil {
		return input, err
	}
	target, err := transferNested(fields, "targetTeam", "id", "version")
	if err != nil {
		return input, err
	}
	if input.TargetTeam.ID, err = httpx.RequiredString(target, "id"); err != nil {
		return input, err
	}
	if input.TargetTeam.Version, err = httpx.VersionInput(target); err != nil {
		return input, err
	}
	input.ExpectedUserID, err = httpx.RequiredString(fields, "expectedUserId")
	return input, err
}

func transferLogID(logger *slog.Logger, field, value string) *slog.Logger {
	id, err := model.CanonicalID(value)
	if err == nil && id == value {
		return logger.With(field, id)
	}
	return logger
}

func (h *projectHandler) transferPreview(w http.ResponseWriter, r *http.Request, p model.Principal) {
	start := time.Now()
	w.Header().Set("Cache-Control", "no-store")
	logger := transferLogID(h.logger.With("user_id", p.UserID), "project_id", r.PathValue("projectId"))
	if _, err := httpx.QueryValues(r); err != nil {
		writeTransferError(w, r, logger, start, "preview", err)
		return
	}
	fields, err := httpx.DecodeObject(w, r, "targetTeamId")
	if err != nil {
		writeTransferError(w, r, logger, start, "preview", err)
		return
	}
	target, err := httpx.RequiredString(fields, "targetTeamId")
	if err != nil {
		writeTransferError(w, r, logger, start, "preview", err)
		return
	}
	logger = transferLogID(logger, "target_team_id", target)
	result, err := h.projects.TransferPreview(r.Context(), p, r.PathValue("projectId"), target)
	if err != nil {
		writeTransferError(w, r, logger, start, "preview", err)
		return
	}
	var actorRole *string
	if result.ActorRole != nil {
		role := string(*result.ActorRole)
		actorRole = &role
	}
	response := api.TransferPreview{SourceTeam: httpx.TeamRefResponse(result.SourceTeam),
		TargetTeam: api.TransferTeam{TeamRef: httpx.TeamRefResponse(result.TargetTeam), Version: result.TargetTeamVersion},
		Ownership:  ownershipResponse(result.Ownership), ActorRole: actorRole}
	logger = logger.With("source_team_id", result.SourceTeam.ID, "duration_ms", time.Since(start).Milliseconds())
	logger.InfoContext(r.Context(), "project transfer preview", "component", "project_transfer", "phase", "preview", "outcome", "success", "request_id", httpx.RequestID(r.Context()))
	httpx.WriteJSON(w, r, logger, http.StatusOK, response)
}

func (h *projectHandler) transfer(w http.ResponseWriter, r *http.Request, p model.Principal) {
	start := time.Now()
	w.Header().Set("Cache-Control", "no-store")
	logger := transferLogID(h.logger.With("user_id", p.UserID), "project_id", r.PathValue("projectId"))
	input, err := transferInput(w, r)
	if err != nil {
		writeTransferError(w, r, logger, start, "prepare", err)
		return
	}
	logger = transferLogID(logger, "source_team_id", input.Ownership.TeamID)
	logger = transferLogID(logger, "target_team_id", input.TargetTeam.ID)
	result, err := h.projects.Transfer(r.Context(), p, r.PathValue("projectId"), input)
	if err != nil {
		writeTransferError(w, r, logger, start, "operation", err)
		return
	}
	var access *api.ProjectAccess
	if result.ActorAccess != nil {
		value := projectAccessResponse(*result.ActorAccess)
		access = &value
	}
	response := api.TransferReceipt{ProjectID: result.ProjectID, Changed: result.Changed,
		SourceTeam: httpx.TeamRefResponse(result.SourceTeam), OwnerTeam: httpx.TeamRefResponse(result.OwnerTeam),
		Ownership: ownershipResponse(result.Ownership), ActorAccess: access}
	writeTransferJSON(w, r, logger, start, response)
}

// Transaction completion takes precedence over any nested domain refusal.
func writeTransferError(w http.ResponseWriter, r *http.Request, logger *slog.Logger, start time.Time, phase string, err error) {
	outcome := "failed"
	var transaction *store.TransactionError
	if phase != "preview" && errors.As(err, &transaction) {
		phase = transaction.Phase
		if transaction.CommitAttempted && transaction.Outcome == store.TransactionUnknown {
			outcome = "unknown"
			err = &model.Fault{Code: "write_outcome_unknown", Message: "The write outcome is unknown. Read the current resource before deciding on another operation.", Cause: err}
		} else if transaction.CleanupFailed {
			err = &model.Fault{Code: "internal_error", Message: "The request could not be completed.", Cause: err}
		} else if transaction.Phase != "operation" || transaction.Outcome != store.TransactionNotCommitted {
			err = &model.Fault{Code: "internal_error", Message: "The request could not be completed.", Cause: err}
		} else if _, ok := httpx.KnownFault(err); !ok && errors.Is(err, model.ErrNotFound) {
			err = &model.Fault{Code: "not_found", Message: "Project or target Team was not found.", Cause: err}
		}
	}
	if outcome == "failed" {
		if fault, ok := httpx.KnownFault(err); ok && httpx.ErrorKind(err) == fault.Code {
			outcome = "refused"
		}
	}
	logger = logger.With("outcome", outcome, "duration_ms", time.Since(start).Milliseconds())
	if outcome == "unknown" {
		logTransferUnknown(logger, r, phase, err)
		if r.Context().Err() == nil {
			httpx.WriteJSON(w, r, logger, http.StatusServiceUnavailable, api.ErrorResponse{Error: api.Error{Code: "write_outcome_unknown", Message: "The write outcome is unknown. Read the current resource before deciding on another operation.", RequestID: httpx.RequestID(r.Context())}})
		}
		return
	}
	httpx.WriteError(w, r, logger, "project_transfer", phase, err)
}

func logTransferUnknown(logger *slog.Logger, r *http.Request, phase string, err error) {
	logger.ErrorContext(r.Context(), "project transfer outcome unknown", "type", "operation_error", "component", "project_transfer", "phase", phase,
		"error_code", "write_outcome_unknown", "cause", httpx.ErrorKind(err), "request_id", httpx.RequestID(r.Context()))
}

func writeTransferJSON(w http.ResponseWriter, r *http.Request, logger *slog.Logger, start time.Time, value any) {
	logger = logger.With("duration_ms", time.Since(start).Milliseconds())
	data, err := json.Marshal(value)
	if err != nil {
		fault := &model.Fault{Code: "write_outcome_unknown", Message: "The committed write response was not delivered.", Cause: err}
		logTransferUnknown(logger.With("outcome", "unknown"), r, "response", fault)
		httpx.WriteJSON(w, r, logger, http.StatusServiceUnavailable, api.ErrorResponse{Error: api.Error{Code: fault.Code, Message: fault.Message, RequestID: httpx.RequestID(r.Context())}})
		return
	}
	if err := r.Context().Err(); err != nil {
		logTransferUnknown(logger.With("outcome", "unknown"), r, "response", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	data = append(data, '\n')
	written, err := w.Write(data)
	if err == nil && written != len(data) {
		err = io.ErrShortWrite
	}
	if err != nil {
		logTransferUnknown(logger.With("outcome", "unknown"), r, "response", err)
		return
	}
	logger.InfoContext(r.Context(), "project transfer response", "type", "resource", "component", "project_transfer", "phase", "response", "outcome", "success", "request_id", httpx.RequestID(r.Context()))
}
