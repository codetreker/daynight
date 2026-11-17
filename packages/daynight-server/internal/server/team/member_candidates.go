package team

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

func candidateSearchInput(w http.ResponseWriter, r *http.Request) (coreteam.CandidateSearchInput, error) {
	if _, err := httpx.QueryValues(r); err != nil {
		return coreteam.CandidateSearchInput{}, err
	}
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		return coreteam.CandidateSearchInput{}, httpx.InvalidInput("query parameters are not accepted")
	}
	fields, err := httpx.DecodeObject(w, r, "expectedUserId", "query", "limit", "cursor")
	if err != nil {
		return coreteam.CandidateSearchInput{}, err
	}
	for _, key := range []string{"expectedUserId", "query", "cursor"} {
		if raw, ok := fields[key]; ok && !jsonunicode.Valid(raw) {
			return coreteam.CandidateSearchInput{}, httpx.InvalidInput(key + " must contain valid Unicode")
		}
	}
	expected, err := httpx.RequiredString(fields, "expectedUserId")
	if err != nil {
		return coreteam.CandidateSearchInput{}, err
	}
	query, err := httpx.RequiredString(fields, "query")
	if err != nil {
		return coreteam.CandidateSearchInput{}, err
	}
	cursor, err := httpx.OptionalString(fields, "cursor")
	if err != nil {
		return coreteam.CandidateSearchInput{}, err
	}
	var limit *int
	if raw, ok := fields["limit"]; ok {
		var value int
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &value) != nil {
			return coreteam.CandidateSearchInput{}, httpx.InvalidInput("limit must be an integer")
		}
		limit = &value
	}
	return coreteam.CandidateSearchInput{ExpectedUserID: expected, Query: query, Limit: limit, Cursor: cursor}, nil
}

func (h *teamHandler) searchMemberCandidates(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", p.UserID)
	id := r.PathValue("teamId")
	if canonical, err := model.CanonicalID(id); err == nil && canonical == id {
		logger = logger.With("team_id", id)
	}
	input, err := candidateSearchInput(w, r)
	if err != nil {
		writeCandidateSearchError(w, r, logger, err)
		return
	}
	result, err := h.teams.SearchMemberCandidates(r.Context(), p, id, input)
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
