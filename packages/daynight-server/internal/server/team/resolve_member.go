package team

import (
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

func resolveMemberInput(w http.ResponseWriter, r *http.Request) (coreteam.ResolveTeamMember, error) {
	if _, err := httpx.QueryValues(r); err != nil {
		return coreteam.ResolveTeamMember{}, err
	}
	fields, err := httpx.DecodeObject(w, r, "expectedUserId", "user")
	if err != nil {
		return coreteam.ResolveTeamMember{}, err
	}
	if raw, ok := fields["expectedUserId"]; ok && !jsonunicode.Valid(raw) {
		return coreteam.ResolveTeamMember{}, httpx.InvalidInput("expectedUserId must contain valid Unicode")
	}
	expected, err := httpx.RequiredString(fields, "expectedUserId")
	if err != nil {
		return coreteam.ResolveTeamMember{}, err
	}
	raw := fields["user"]
	if !jsonunicode.Valid(raw) {
		return coreteam.ResolveTeamMember{}, httpx.InvalidInput("user must contain valid Unicode")
	}
	user, err := jsonobject.Decode(raw, "user", "externalUserId")
	if err != nil {
		return coreteam.ResolveTeamMember{}, httpx.InvalidInput(err.Error())
	}
	externalID, err := httpx.RequiredString(user, "externalUserId")
	if err != nil {
		return coreteam.ResolveTeamMember{}, err
	}
	return coreteam.ResolveTeamMember{ExpectedUserID: expected, ExternalUserID: externalID}, nil
}

func (h *teamHandler) resolveDirectMember(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", p.UserID)
	input, err := resolveMemberInput(w, r)
	if err != nil {
		writeResolveMemberError(w, r, logger, err)
		return
	}
	member, err := h.resolveMember(r.Context(), p, r.PathValue("teamId"), input)
	if err != nil {
		writeResolveMemberError(w, r, logger, err)
		return
	}
	response := api.ResolveTeamMemberResponse{ActorRole: string(model.ProjectAdmin)}
	if member != nil {
		value := teamMemberResponse(*member)
		response.Membership = &value
	}
	httpx.WriteJSON(w, r, logger, http.StatusOK, response)
}

func writeResolveMemberError(w http.ResponseWriter, r *http.Request, logger *slog.Logger, err error) {
	// An unsuccessful transaction completion is a read failure, not a write receipt.
	if fault, classified := coreteam.WriteFault(err); classified && (fault.Code == "internal_error" || fault.Code == "write_outcome_unknown") {
		httpx.WriteError(w, r, logger, "team", "resolve_member", &model.Fault{Code: "internal_error", Message: "The request could not be completed.", Cause: err})
		return
	}
	if failed, _ := store.DatabaseErrorFacts(err); failed || httpx.ErrorKind(err) == "network" {
		httpx.WriteError(w, r, logger, "team", "resolve_member", err)
		return
	}
	if fault, known := httpx.KnownFault(err); known && fault.Code == "unauthenticated" {
		httpx.WriteError(w, r, logger, "team", "resolve_member", err)
		return
	}
	writeTeamError(w, r, logger, "resolve_member", err)
}
