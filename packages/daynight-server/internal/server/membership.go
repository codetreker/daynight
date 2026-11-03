package server

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

type MembershipRoutes struct {
	memberships *service.Memberships
	auth        *Authentication
	logger      *slog.Logger
}

// NewMembershipRoutes composes membership handlers without activating the application mux.
func NewMembershipRoutes(memberships *service.Memberships, auth *Authentication, logger *slog.Logger) *MembershipRoutes {
	return &MembershipRoutes{memberships: memberships, auth: auth, logger: logger}
}

func (h *MembershipRoutes) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/projects/{projectId}/members", h.auth.Require(h.listMembers))
	mux.HandleFunc("PATCH /api/v1/projects/{projectId}/members/{userId}", h.auth.Require(h.setRole))
	mux.HandleFunc("DELETE /api/v1/projects/{projectId}/members/{userId}", h.auth.Require(h.removeMember))
	mux.HandleFunc("GET /api/v1/projects/{projectId}/invitations", h.auth.Require(h.listInvitations))
	mux.HandleFunc("POST /api/v1/projects/{projectId}/invitations", h.auth.Require(h.createInvitation))
	mux.HandleFunc("DELETE /api/v1/projects/{projectId}/invitations/{inviteId}", h.auth.Require(h.revokeInvitation))
	mux.HandleFunc("POST /api/v1/invitations/inspect", h.auth.Require(h.inspectInvitation))
	mux.HandleFunc("POST /api/v1/invitations/accept", h.auth.Require(h.acceptInvitation))
	for path, methods := range map[string]string{
		"/api/v1/projects/{projectId}/members":                "GET, HEAD",
		"/api/v1/projects/{projectId}/members/{userId}":       "PATCH, DELETE",
		"/api/v1/projects/{projectId}/invitations":            "GET, HEAD, POST",
		"/api/v1/projects/{projectId}/invitations/{inviteId}": "DELETE",
		"/api/v1/invitations/inspect":                         "POST",
		"/api/v1/invitations/accept":                          "POST",
	} {
		mux.HandleFunc(path, h.auth.Require(func(w http.ResponseWriter, request *http.Request, _ core.Principal) {
			methodNotAllowed(h.logger, methods)(w, request)
		}))
	}
}

func membershipCompleted(request *http.Request, logger *slog.Logger, phase string) {
	logger.InfoContext(request.Context(), "project membership operation completed", "type", "resource", "component", "membership", "phase", phase, "request_id", RequestID(request.Context()))
}

func memberResponse(member core.ProjectMember) api.ProjectMember {
	return api.ProjectMember{ProjectID: member.Grant.ProjectID, UserID: member.Grant.UserID, Email: member.Email,
		Name: member.Name, AvatarURL: member.AvatarURL, Role: string(member.Grant.Role), Version: member.Grant.Version,
		CreatedAt: member.Grant.CreatedAt.UTC(), UpdatedAt: member.Grant.UpdatedAt.UTC()}
}

func invitationResponse(invitation core.ProjectInvitation) api.ProjectInvitation {
	return api.ProjectInvitation{ID: invitation.ID, ProjectID: invitation.ProjectID, CreatedBy: invitation.CreatedBy,
		CreatedAt: invitation.CreatedAt.UTC(), ExpiresAt: invitation.ExpiresAt.UTC(), ConsumedBy: invitation.ConsumedBy,
		ConsumedAt: invitation.ConsumedAt, RevokedAt: invitation.RevokedAt}
}

func membershipVersion(fields map[string]json.RawMessage) (int64, error) {
	var version int64
	if err := json.Unmarshal(fields["version"], &version); err != nil || version < 1 {
		return 0, invalidInput("version is required and must be a positive 64-bit integer")
	}
	return version, nil
}

func (h *MembershipRoutes) scoped(request *http.Request, principal core.Principal) (*slog.Logger, string, error) {
	logger := h.logger.With("user_id", principal.UserID)
	id, err := service.CanonicalID(request.PathValue("projectId"))
	if err != nil {
		return logger, "", err
	}
	return logger.With("project_id", id), id, nil
}

func (h *MembershipRoutes) listMembers(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger, id, err := h.scoped(request, principal)
	if err == nil {
		_, err = queryValues(request)
	}
	if err != nil {
		writeError(w, request, logger, "membership", "list", err)
		return
	}
	members, err := h.memberships.List(request.Context(), principal, id)
	if err != nil {
		writeError(w, request, logger, "membership", "list", err)
		return
	}
	response := api.ProjectMemberList{Items: make([]api.ProjectMember, 0, len(members))}
	for _, member := range members {
		response.Items = append(response.Items, memberResponse(member))
	}
	membershipCompleted(request, logger, "list")
	writeJSON(w, request, logger, http.StatusOK, response)
}

func (h *MembershipRoutes) setRole(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	logger, projectID, err := h.scoped(request, principal)
	var fields map[string]json.RawMessage
	if err == nil {
		fields, err = decodeObject(w, request, "version", "role")
	}
	var version int64
	if err == nil {
		version, err = membershipVersion(fields)
	}
	var role string
	if err == nil {
		role, err = requiredString(fields, "role")
	}
	if err != nil {
		writeError(w, request, logger, "membership", "set_role", err)
		return
	}
	member, err := h.memberships.SetRole(request.Context(), principal, projectID, request.PathValue("userId"), version, core.ProjectRole(role))
	if err != nil {
		writeError(w, request, logger, "membership", "set_role", err)
		return
	}
	membershipCompleted(request, logger, "set_role")
	writeJSON(w, request, logger, http.StatusOK, memberResponse(member))
}

func (h *MembershipRoutes) removeMember(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	logger, projectID, err := h.scoped(request, principal)
	var fields map[string]json.RawMessage
	if err == nil {
		fields, err = decodeObject(w, request, "version")
	}
	var version int64
	if err == nil {
		version, err = membershipVersion(fields)
	}
	if err == nil {
		err = h.memberships.Remove(request.Context(), principal, projectID, request.PathValue("userId"), version)
	}
	if err != nil {
		writeError(w, request, logger, "membership", "remove", err)
		return
	}
	membershipCompleted(request, logger, "remove")
	w.WriteHeader(http.StatusNoContent)
}

func (h *MembershipRoutes) listInvitations(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger, id, err := h.scoped(request, principal)
	if err == nil {
		_, err = queryValues(request)
	}
	if err != nil {
		writeError(w, request, logger, "membership", "list_invitations", err)
		return
	}
	invitations, err := h.memberships.ListInvitations(request.Context(), principal, id)
	if err != nil {
		writeError(w, request, logger, "membership", "list_invitations", err)
		return
	}
	response := api.ProjectInvitationList{Items: make([]api.ProjectInvitation, 0, len(invitations))}
	for _, invitation := range invitations {
		response.Items = append(response.Items, invitationResponse(invitation))
	}
	membershipCompleted(request, logger, "list_invitations")
	writeJSON(w, request, logger, http.StatusOK, response)
}

func (h *MembershipRoutes) createInvitation(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger, id, err := h.scoped(request, principal)
	if err == nil {
		_, err = decodeObject(w, request)
	}
	if err != nil {
		writeError(w, request, logger, "membership", "create_invitation", err)
		return
	}
	result, err := h.memberships.CreateInvitation(request.Context(), principal, id)
	if err != nil {
		writeError(w, request, logger, "membership", "create_invitation", err)
		return
	}
	membershipCompleted(request, logger, "create_invitation")
	writeCreated(w, request, logger, "/api/v1/projects/"+id+"/invitations/"+result.Invitation.ID,
		api.CreatedProjectInvitation{ProjectInvitation: invitationResponse(result.Invitation), Link: h.auth.origin + "/invitations#" + result.Secret})
}

func (h *MembershipRoutes) revokeInvitation(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	logger, id, err := h.scoped(request, principal)
	if err == nil {
		err = h.memberships.RevokeInvitation(request.Context(), principal, id, request.PathValue("inviteId"))
	}
	if err != nil {
		writeError(w, request, logger, "membership", "revoke_invitation", err)
		return
	}
	membershipCompleted(request, logger, "revoke_invitation")
	w.WriteHeader(http.StatusNoContent)
}

func invitationToken(w http.ResponseWriter, request *http.Request) (string, error) {
	fields, err := decodeObject(w, request, "token")
	if err != nil {
		return "", err
	}
	return requiredString(fields, "token")
}

func (h *MembershipRoutes) inspectInvitation(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", principal.UserID)
	token, err := invitationToken(w, request)
	if err != nil {
		writeError(w, request, logger, "membership", "inspect_invitation", err)
		return
	}
	inspection, err := h.memberships.InspectInvitation(request.Context(), principal, token)
	if err != nil {
		writeError(w, request, logger, "membership", "inspect_invitation", err)
		return
	}
	response := api.ProjectInvitationInspection{ProjectID: inspection.ProjectID, ProjectName: inspection.ProjectName}
	if inspection.Member != nil {
		member := memberResponse(*inspection.Member)
		response.Member = &member
	}
	logger = logger.With("project_id", inspection.ProjectID)
	membershipCompleted(request, logger, "inspect_invitation")
	writeJSON(w, request, logger, http.StatusOK, response)
}

func (h *MembershipRoutes) acceptInvitation(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", principal.UserID)
	token, err := invitationToken(w, request)
	if err != nil {
		writeError(w, request, logger, "membership", "accept_invitation", err)
		return
	}
	member, err := h.memberships.AcceptInvitation(request.Context(), principal, token)
	if err != nil {
		writeError(w, request, logger, "membership", "accept_invitation", err)
		return
	}
	logger = logger.With("project_id", member.Grant.ProjectID)
	membershipCompleted(request, logger, "accept_invitation")
	writeJSON(w, request, logger, http.StatusOK, memberResponse(member))
}
