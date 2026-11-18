package project

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
	"github.com/google/uuid"
)

type DirectMemberOperations interface {
	AddExistingMember(context.Context, model.Principal, string, string, string) (coreproject.ExistingMemberResult, error)
}

type directMemberHandler struct {
	members DirectMemberOperations
	logger  *slog.Logger
}

// RegisterDirectMemberRoute mounts the existing-account Project member operation.
func RegisterDirectMemberRoute(mux *http.ServeMux, members DirectMemberOperations, auth RouteAuthentication, logger *slog.Logger) {
	h := &directMemberHandler{members: members, logger: logger}
	mux.HandleFunc("POST /api/v1/projects/{projectId}/members/{userId}", auth.Require(h.add))
}

type directMemberReceipt struct {
	Added       bool                   `json:"added"`
	Participant api.ProjectParticipant `json:"participant"`
	ActorAccess api.ProjectAccess      `json:"actorAccess"`
}

func directMemberInput(w http.ResponseWriter, r *http.Request) (string, error) {
	if _, err := httpx.QueryValues(r); err != nil {
		return "", err
	}
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		return "", httpx.InvalidInput("query parameters are not accepted")
	}
	fields, err := httpx.DecodeObject(w, r, "expectedUserId")
	if err != nil {
		return "", err
	}
	if raw, ok := fields["expectedUserId"]; ok && !jsonunicode.Valid(raw) {
		return "", httpx.InvalidInput("expectedUserId must contain valid Unicode")
	}
	return httpx.RequiredString(fields, "expectedUserId")
}

func (h *directMemberHandler) add(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	r = r.WithContext(httpx.WithRedactedOperationDiagnostics(r.Context()))
	logger := h.logger.With("user_id", p.UserID)
	for _, field := range []struct{ key, id string }{{"project_id", r.PathValue("projectId")}, {"target_user_id", r.PathValue("userId")}} {
		if canonical, err := model.CanonicalID(field.id); err == nil && canonical == field.id && canonical != uuid.Nil.String() {
			logger = logger.With(field.key, field.id)
		}
	}
	expected, err := directMemberInput(w, r)
	if err != nil {
		writeDirectMemberError(w, r, logger, err)
		return
	}
	result, err := h.members.AddExistingMember(r.Context(), p, r.PathValue("projectId"), r.PathValue("userId"), expected)
	if err != nil {
		writeDirectMemberError(w, r, logger, err)
		return
	}
	httpx.WriteMutationJSON(w, r, logger, "project_member", http.StatusOK, directMemberReceipt{Added: result.Added, Participant: participantResponse(result.Participant), ActorAccess: AccessResponse(result.ActorAccess)})
}

func writeDirectMemberError(w http.ResponseWriter, r *http.Request, logger *slog.Logger, err error) {
	// Transaction completion takes precedence over nested business refusals.
	if directMemberUnknownCommit(err) {
		fault := &model.Fault{Code: "write_outcome_unknown", Message: "The write outcome is unknown. Read the current resource before deciding on another operation.", Cause: err}
		httpx.LogFailure(logger.With("write_outcome", "unknown"), r.Context(), "project_member", "commit", fault)
		httpx.WriteJSON(w, r, logger, http.StatusServiceUnavailable, api.ErrorResponse{Error: api.Error{Code: fault.Code, Message: fault.Message, RequestID: httpx.RequestID(r.Context())}})
		return
	}
	if fault, classified := coreteam.WriteFault(err); classified && (fault.Code == "internal_error" || fault.Code == "write_outcome_unknown") {
		status, phase := http.StatusInternalServerError, "completion"
		if fault.Code == "write_outcome_unknown" {
			status, phase = http.StatusServiceUnavailable, "commit"
			logger = logger.With("write_outcome", "unknown")
		}
		httpx.LogFailure(logger, r.Context(), "project_member", phase, fault)
		httpx.WriteJSON(w, r, logger, status, api.ErrorResponse{Error: api.Error{Code: fault.Code, Message: fault.Message, RequestID: httpx.RequestID(r.Context())}})
		return
	}
	httpx.WriteError(w, r, logger, "project_member", "add", err)
}

func directMemberUnknownCommit(err error) bool {
	if err == nil {
		return false
	}
	if tx, ok := err.(*store.TransactionError); ok && tx.CommitAttempted && tx.Outcome == store.TransactionUnknown {
		return true
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		for _, child := range joined.Unwrap() {
			if directMemberUnknownCommit(child) {
				return true
			}
		}
		return false
	}
	return directMemberUnknownCommit(errors.Unwrap(err))
}
