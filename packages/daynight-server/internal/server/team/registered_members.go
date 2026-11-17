package team

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
	"github.com/google/uuid"
)

func existingMemberInput(w http.ResponseWriter, r *http.Request) (string, error) {
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

func (h *teamHandler) addExistingTeamMember(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	r = r.WithContext(httpx.WithRedactedOperationDiagnostics(r.Context()))
	logger := h.logger.With("user_id", p.UserID)
	for _, field := range []struct{ key, id string }{{"team_id", r.PathValue("teamId")}, {"target_user_id", r.PathValue("userId")}} {
		if canonical, err := model.CanonicalID(field.id); err == nil && canonical == field.id && canonical != uuid.Nil.String() {
			logger = logger.With(field.key, field.id)
		}
	}
	expected, err := existingMemberInput(w, r)
	if err != nil {
		writeMemberError(w, r, logger, "add_existing_member", err)
		return
	}
	result, err := h.addExistingMember(r.Context(), p, r.PathValue("teamId"), r.PathValue("userId"), expected)
	if err != nil {
		writeMemberError(w, r, logger, "add_existing_member", err)
		return
	}
	member := result.Membership
	receipt := api.AddExistingTeamMemberReceipt{Membership: api.TeamMemberWithProfile{TeamMember: teamMemberResponse(member.Membership), Profile: api.ProjectParticipantProfile{Name: member.Profile.Name, Email: member.Profile.Email, AvatarURL: member.Profile.AvatarURL}}, Added: result.Added, ActorRole: string(model.ProjectAdmin)}
	writeTeamJSON(w, r, logger, http.StatusOK, receipt)
}
