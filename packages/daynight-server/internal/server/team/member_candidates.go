package team

import (
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func (h *teamHandler) searchMemberCandidates(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", p.UserID)
	id := r.PathValue("teamId")
	if canonical, err := model.CanonicalID(id); err == nil && canonical == id {
		logger = logger.With("team_id", id)
	}
	input, err := httpx.DecodeCandidateSearch(w, r)
	if err != nil {
		writeCandidateSearchError(w, r, logger, err)
		return
	}
	result, err := h.teams.SearchMemberCandidates(r.Context(), p, id, coreteam.CandidateSearchInput{ExpectedUserID: input.ExpectedUserID, Query: input.Query, Limit: input.Limit, Cursor: input.Cursor})
	if err != nil {
		writeCandidateSearchError(w, r, logger, err)
		return
	}
	response := api.TeamMemberCandidatePage{Items: make([]api.TeamMemberCandidate, 0, len(result.Items)), NextCursor: result.NextCursor, ActorRole: string(model.ProjectAdmin)}
	for _, item := range result.Items {
		response.Items = append(response.Items, api.TeamMemberCandidate{UserID: item.UserID, Profile: api.ProjectParticipantProfile{Name: item.Profile.Name, Email: item.Profile.Email, AvatarURL: item.Profile.AvatarURL}})
	}
	httpx.WriteOperationJSON(w, r, logger, "member_candidate_search", http.StatusOK, response)
}

func writeCandidateSearchError(w http.ResponseWriter, r *http.Request, logger *slog.Logger, err error) {
	// Read-only transaction completion errors are never uncertain writes.
	if fault, classified := coreteam.WriteFault(err); classified && (fault.Code == "internal_error" || fault.Code == "write_outcome_unknown") {
		err = &model.Fault{Code: "internal_error", Message: "The request could not be completed.", Cause: err}
	}
	httpx.WriteError(w, r, logger, "member_candidate_search", "search", err)
}
