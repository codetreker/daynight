package server

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

type MembershipRoutes struct {
	memberships *service.Memberships
	auth        *authhttp.Authentication
	logger      *slog.Logger
}

// NewMembershipRoutes composes membership handlers without activating the application mux.
func NewMembershipRoutes(memberships *service.Memberships, auth *authhttp.Authentication, logger *slog.Logger) *MembershipRoutes {
	return &MembershipRoutes{memberships: memberships, auth: auth, logger: logger}
}

func (h *MembershipRoutes) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/projects/{projectId}/members", h.auth.Require(h.listMembers))
	mux.HandleFunc("PATCH /api/v1/projects/{projectId}/members/{userId}", h.auth.Require(h.setRole))
	mux.HandleFunc("DELETE /api/v1/projects/{projectId}/members/{userId}", h.auth.Require(h.removeMember))
	mux.HandleFunc("PUT /api/v1/projects/{projectId}/grants/{userId}", h.auth.Require(h.setGrant))
	mux.HandleFunc("DELETE /api/v1/projects/{projectId}/grants/{userId}", h.auth.Require(h.removeGrant))
	mux.HandleFunc("GET /api/v1/projects/{projectId}/invitations", h.auth.Require(h.listInvitations))
	mux.HandleFunc("POST /api/v1/projects/{projectId}/invitations", h.auth.Require(h.createInvitation))
	mux.HandleFunc("DELETE /api/v1/projects/{projectId}/invitations/{inviteId}", h.auth.Require(h.revokeInvitation))
	mux.HandleFunc("POST /api/v1/invitations/inspect", h.auth.Require(h.inspectInvitation))
	mux.HandleFunc("POST /api/v1/invitations/accept", h.auth.Require(h.acceptInvitation))
	for path, methods := range map[string]string{
		"/api/v1/projects/{projectId}/members":                "GET, HEAD",
		"/api/v1/projects/{projectId}/members/{userId}":       "PATCH, DELETE",
		"/api/v1/projects/{projectId}/grants/{userId}":        "PUT, DELETE",
		"/api/v1/projects/{projectId}/invitations":            "GET, HEAD, POST",
		"/api/v1/projects/{projectId}/invitations/{inviteId}": "DELETE",
		"/api/v1/invitations/inspect":                         "POST",
		"/api/v1/invitations/accept":                          "POST",
	} {
		mux.HandleFunc(path, h.auth.Require(func(w http.ResponseWriter, request *http.Request, _ model.Principal) {
			httpx.MethodNotAllowed(h.logger, methods)(w, request)
		}))
	}
}

func membershipCompleted(request *http.Request, logger *slog.Logger, phase string) {
	logger.InfoContext(request.Context(), "project membership operation completed", "type", "resource", "component", "membership", "phase", phase, "request_id", httpx.RequestID(request.Context()))
}

func invitationWriteError(w http.ResponseWriter, request *http.Request, logger *slog.Logger, phase string, err error) {
	var transaction *store.TransactionError
	if errors.As(err, &transaction) && transaction.Outcome == store.TransactionUnknown {
		const message = "Invitation write outcome is unknown. Review current state before starting another operation."
		logger.ErrorContext(request.Context(), "operation failed", "type", "operation_error", "component", "membership", "phase", phase, "cause", httpx.ErrorKind(err), "error_code", "write_outcome_unknown", "diagnostic", message, "request_id", httpx.RequestID(request.Context()))
		httpx.WriteJSON(w, request, logger, http.StatusServiceUnavailable, api.ErrorResponse{Error: api.Error{Code: "write_outcome_unknown", Message: message, RequestID: httpx.RequestID(request.Context())}})
		return
	}
	httpx.WriteError(w, request, logger, "membership", phase, err)
}

func participantResponse(participant model.ProjectParticipant) api.ProjectParticipant {
	var direct *api.ProjectGrant
	if grant := participant.DirectGrant; grant != nil {
		response := projectGrantResponse(*grant)
		direct = &response
	}
	var inherited *api.ProjectInheritance
	if source := participant.InheritedFrom; source != nil {
		inherited = &api.ProjectInheritance{Team: httpx.TeamRefResponse(source.Team), Role: string(source.Role)}
	}
	return api.ProjectParticipant{InheritedFrom: inherited, UserID: participant.UserID, EffectiveRole: string(participant.EffectiveRole), DirectGrant: direct,
		Profile: api.ProjectParticipantProfile{Name: participant.Profile.Name, Email: participant.Profile.Email, AvatarURL: participant.Profile.AvatarURL}}
}

func invitationResponse(invitation model.ProjectInvitation) api.ProjectInvitation {
	return api.ProjectInvitation{ID: invitation.ID, ProjectID: invitation.ProjectID, CreatedBy: invitation.CreatedBy,
		CreatedAt: invitation.CreatedAt.UTC(), ExpiresAt: invitation.ExpiresAt.UTC(), ConsumedBy: invitation.ConsumedBy,
		ConsumedAt: invitation.ConsumedAt, RevokedAt: invitation.RevokedAt}
}

func membershipVersion(fields map[string]json.RawMessage) (int64, error) {
	var version int64
	if err := json.Unmarshal(fields["version"], &version); err != nil || version < 1 {
		return 0, httpx.InvalidInput("version is required and must be a positive 64-bit integer")
	}
	return version, nil
}

func (h *MembershipRoutes) scoped(request *http.Request, principal model.Principal) (*slog.Logger, string, error) {
	logger := h.logger.With("user_id", principal.UserID)
	id, err := model.CanonicalID(request.PathValue("projectId"))
	if err != nil {
		return logger, "", err
	}
	return logger.With("project_id", id), id, nil
}

func (h *MembershipRoutes) listMembers(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger, id, err := h.scoped(request, principal)
	if err == nil {
		_, err = httpx.QueryValues(request)
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "membership", "list", err)
		return
	}
	members, err := h.memberships.ListWithAccess(request.Context(), principal, id)
	if err != nil {
		httpx.WriteError(w, request, logger, "membership", "list", err)
		return
	}
	response := api.ProjectParticipantList{Items: make([]api.ProjectParticipant, 0, len(members.Items)), ActorAccess: projectAccessResponse(members.ActorAccess)}
	for _, member := range members.Items {
		response.Items = append(response.Items, participantResponse(member))
	}
	membershipCompleted(request, logger, "list")
	httpx.WriteJSON(w, request, logger, http.StatusOK, response)
}

func (h *MembershipRoutes) setRole(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	logger, projectID, err := h.scoped(request, principal)
	var fields map[string]json.RawMessage
	if err == nil {
		fields, err = httpx.DecodeObject(w, request, "version", "role", "expectedUserId")
	}
	var version int64
	if err == nil {
		version, err = membershipVersion(fields)
	}
	var role string
	if err == nil {
		role, err = httpx.RequiredString(fields, "role")
	}
	var expectedUserID string
	if err == nil {
		expectedUserID, err = httpx.RequiredString(fields, "expectedUserId")
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "membership", "set_role", err)
		return
	}
	grant, err := h.memberships.SetRole(request.Context(), principal, projectID, request.PathValue("userId"), service.SetProjectMemberRole{Version: version, Role: model.ProjectRole(role), ExpectedUserID: expectedUserID})
	if err != nil {
		httpx.WriteError(w, request, logger, "membership", "set_role", err)
		return
	}
	membershipCompleted(request, logger, "set_role")
	httpx.WriteJSON(w, request, logger, http.StatusOK, projectGrantResponse(grant))
}

func (h *MembershipRoutes) removeMember(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	logger, projectID, err := h.scoped(request, principal)
	var fields map[string]json.RawMessage
	if err == nil {
		fields, err = httpx.DecodeObject(w, request, "version", "expectedUserId")
	}
	var version int64
	if err == nil {
		version, err = membershipVersion(fields)
	}
	var expectedUserID string
	if err == nil {
		expectedUserID, err = httpx.RequiredString(fields, "expectedUserId")
	}
	if err == nil {
		err = h.memberships.Remove(request.Context(), principal, projectID, request.PathValue("userId"), service.RemoveProjectMember{Version: version, ExpectedUserID: expectedUserID})
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "membership", "remove", err)
		return
	}
	membershipCompleted(request, logger, "remove")
	w.WriteHeader(http.StatusNoContent)
}

func (h *MembershipRoutes) listInvitations(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger, id, err := h.scoped(request, principal)
	if err == nil {
		_, err = httpx.QueryValues(request)
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "membership", "list_invitations", err)
		return
	}
	invitations, err := h.memberships.ListInvitations(request.Context(), principal, id)
	if err != nil {
		httpx.WriteError(w, request, logger, "membership", "list_invitations", err)
		return
	}
	response := api.ProjectInvitationList{Items: make([]api.ProjectInvitation, 0, len(invitations))}
	for _, invitation := range invitations {
		response.Items = append(response.Items, invitationResponse(invitation))
	}
	membershipCompleted(request, logger, "list_invitations")
	httpx.WriteJSON(w, request, logger, http.StatusOK, response)
}

func (h *MembershipRoutes) createInvitation(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger, id, err := h.scoped(request, principal)
	var expectedUserID string
	if err == nil {
		expectedUserID, err = invitationActor(w, request)
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "membership", "create_invitation", err)
		return
	}
	result, err := h.memberships.CreateInvitation(request.Context(), principal, id, expectedUserID)
	if err != nil {
		invitationWriteError(w, request, logger, "create_invitation", err)
		return
	}
	membershipCompleted(request, logger, "create_invitation")
	httpx.WriteCreated(w, request, logger, "/api/v1/projects/"+id+"/invitations/"+result.Invitation.ID,
		api.CreatedProjectInvitation{ProjectInvitation: invitationResponse(result.Invitation), Link: h.auth.Origin() + "/invitations#" + result.Secret})
}

func (h *MembershipRoutes) revokeInvitation(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	logger, id, err := h.scoped(request, principal)
	var expectedUserID string
	if err == nil {
		expectedUserID, err = invitationActor(w, request)
	}
	if err == nil {
		err = h.memberships.RevokeInvitation(request.Context(), principal, id, request.PathValue("inviteId"), expectedUserID)
	}
	if err != nil {
		invitationWriteError(w, request, logger, "revoke_invitation", err)
		return
	}
	membershipCompleted(request, logger, "revoke_invitation")
	w.WriteHeader(http.StatusNoContent)
}

func invitationActor(w http.ResponseWriter, request *http.Request) (string, error) {
	fields, err := httpx.DecodeObject(w, request, "expectedUserId")
	if err != nil {
		return "", err
	}
	return httpx.RequiredString(fields, "expectedUserId")
}

func invitationToken(w http.ResponseWriter, request *http.Request) (string, error) {
	fields, err := httpx.DecodeObject(w, request, "token")
	if err != nil {
		return "", err
	}
	return httpx.RequiredString(fields, "token")
}

func (h *MembershipRoutes) inspectInvitation(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", principal.UserID)
	token, err := invitationToken(w, request)
	if err != nil {
		httpx.WriteError(w, request, logger, "membership", "inspect_invitation", err)
		return
	}
	inspection, err := h.memberships.InspectInvitation(request.Context(), principal, token)
	if err != nil {
		httpx.WriteError(w, request, logger, "membership", "inspect_invitation", err)
		return
	}
	response := api.ProjectInvitationInspection{ProjectID: inspection.ProjectID, ProjectName: inspection.ProjectName}
	if inspection.DirectGrant != nil {
		grant := projectGrantResponse(*inspection.DirectGrant)
		response.DirectGrant = &grant
	}
	if inspection.Access != nil {
		access := projectAccessResponse(*inspection.Access)
		response.Access = &access
	}
	logger = logger.With("project_id", inspection.ProjectID)
	membershipCompleted(request, logger, "inspect_invitation")
	httpx.WriteJSON(w, request, logger, http.StatusOK, response)
}

func (h *MembershipRoutes) acceptInvitation(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", principal.UserID)
	fields, err := httpx.DecodeObject(w, request, "token", "expectedUserId")
	var token, expectedUserID string
	if err == nil {
		token, err = httpx.RequiredString(fields, "token")
	}
	if err == nil {
		expectedUserID, err = httpx.RequiredString(fields, "expectedUserId")
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "membership", "accept_invitation", err)
		return
	}
	result, err := h.memberships.AcceptInvitation(request.Context(), principal, token, expectedUserID)
	if err != nil {
		invitationWriteError(w, request, logger, "accept_invitation", err)
		return
	}
	logger = logger.With("project_id", result.ProjectID)
	membershipCompleted(request, logger, "accept_invitation")
	httpx.WriteJSON(w, request, logger, http.StatusOK, api.ProjectInvitationAcceptance{ProjectID: result.ProjectID, DirectGrant: projectGrantResponse(result.DirectGrant), Access: projectAccessResponse(result.Access), Joined: result.Joined, Consumed: result.Consumed})
}
