package project

import (
	"errors"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
)

func (h *projectHandler) deletionPreview(w http.ResponseWriter, r *http.Request, p model.Principal) {
	start := time.Now()
	w.Header().Set("Cache-Control", "no-store")
	logger := transferLogID(h.logger.With("user_id", p.UserID), "project_id", r.PathValue("projectId"))
	page, err := httpx.PageRequest(r)
	if err != nil {
		httpx.WriteError(w, r, logger, "project_deletion", "preview", err)
		return
	}
	result, err := h.projects.DeletionPreview(r.Context(), p, r.PathValue("projectId"), page)
	if err != nil {
		httpx.WriteError(w, r, logger, "project_deletion", "preview", err)
		return
	}
	out := api.ProjectDeletionPreview{ObservedAt: result.ObservedAt, Project: api.ProjectDeletionIdentity{ID: result.Project.ID, Name: result.Project.Name, RepoURL: result.Project.RepoURL, OwnerTeam: httpx.TeamRefResponse(result.OwnerTeam)}, Summary: api.ProjectDeletionSummary{TaskCount: result.Summary.TaskCount, UnfinishedTaskCount: result.Summary.UnfinishedTaskCount, AttachmentCount: result.Summary.AttachmentCount}, ActiveClaims: make([]api.ProjectDeletionClaim, 0, len(result.ActiveClaims)), NextCursor: result.NextCursor}
	for _, claim := range result.ActiveClaims {
		out.ActiveClaims = append(out.ActiveClaims, api.ProjectDeletionClaim{TaskID: claim.TaskID, Title: claim.Title, Worker: api.ProjectDeletionWorker{MachineName: claim.MachineName, Platform: string(claim.Platform), Phase: string(claim.Phase), Paused: claim.Paused, Connectivity: claim.Connectivity}})
	}
	logger.InfoContext(r.Context(), "project deletion preview", "component", "project_deletion", "phase", "preview", "outcome", "success", "duration_ms", time.Since(start).Milliseconds(), "request_id", httpx.RequestID(r.Context()))
	httpx.WriteJSON(w, r, logger, http.StatusOK, out)
}

func (h *projectHandler) delete(w http.ResponseWriter, r *http.Request, p model.Principal) {
	start := time.Now()
	w.Header().Set("Cache-Control", "no-store")
	logger := transferLogID(h.logger.With("user_id", p.UserID), "project_id", r.PathValue("projectId"))
	if _, err := httpx.QueryValues(r); err != nil {
		httpx.CloseUnreadBody(w, r)
		httpx.WriteError(w, r, logger, "project_deletion", "prepare", err)
		return
	}
	if r.Body != nil {
		_, err := httpx.ReadBody(w, r, 0, transport.JSONBodyReadTimeout)
		if err != nil {
			var bodyErr *httpx.BodyReadError
			if errors.As(err, &bodyErr) && bodyErr.Status == http.StatusRequestEntityTooLarge {
				httpx.WriteError(w, r, logger, "project_deletion", "prepare", httpx.InvalidInput("DELETE does not accept a request body"))
			} else {
				httpx.WriteBodyError(w, r, logger, "project_deletion", "prepare", err)
			}
			return
		}
	}
	receipt, err := h.projects.Delete(r.Context(), p, r.PathValue("projectId"))
	if err != nil {
		var failure *service.DeletionFailure
		if errors.As(err, &failure) {
			if failure.Outcome != store.TransactionNotCommitted {
				httpx.LogFailure(logger.With("write_outcome", "unknown", "duration_ms", time.Since(start).Milliseconds()), r.Context(), "project_deletion", "completion", err)
				httpx.WriteJSON(w, r, logger, http.StatusServiceUnavailable, api.ErrorResponse{Error: api.Error{Code: "write_outcome_unknown", Message: "The Project deletion outcome is unknown.", RequestID: httpx.RequestID(r.Context())}})
				return
			}
			if fault, ok := httpx.KnownFault(err); ok && httpx.ErrorKind(err) == fault.Code {
				httpx.WriteError(w, r, logger, "project_deletion", "operation", err)
				return
			}
			httpx.LogFailure(logger.With("write_outcome", "not_committed", "duration_ms", time.Since(start).Milliseconds()), r.Context(), "project_deletion", "completion", err)
			outcome := "not_committed"
			httpx.WriteJSON(w, r, logger, http.StatusInternalServerError, api.ErrorResponse{Error: api.Error{Code: "internal_error", Message: "internal server error", RequestID: httpx.RequestID(r.Context()), Details: &api.ErrorDetails{WriteOutcome: &outcome}}})
			return
		}
		httpx.WriteError(w, r, logger, "project_deletion", "operation", err)
		return
	}
	logger.InfoContext(r.Context(), "project deleted", "component", "project_deletion", "phase", "commit", "outcome", "committed", "duration_ms", time.Since(start).Milliseconds(), "request_id", httpx.RequestID(r.Context()))
	httpx.WriteMutationJSON(w, r, logger, "project_deletion", http.StatusOK, api.ProjectDeletionReceipt{ProjectID: receipt.ProjectID, Deleted: receipt.Deleted})
}
