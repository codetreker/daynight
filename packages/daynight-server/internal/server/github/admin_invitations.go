package github

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func (h *adminHandler) listInvitations(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "list_admin_invitations", false, http.StatusOK, func(work *http.Request, id string) (any, error) {
		input, err := adminPageInput(work)
		if err != nil {
			return nil, err
		}
		page, err := h.operations.ListAdminInvitations(work.Context(), p, id, input)
		if err != nil {
			return nil, err
		}
		response := api.GitHubAppAdminInvitationPage{Items: make([]api.GitHubAppAdminInvitation, 0, len(page.Items)), NextCursor: page.NextCursor}
		for _, invite := range page.Items {
			response.Items = append(response.Items, adminInvitationResponse(invite))
		}
		return response, nil
	})
}
func (h *adminHandler) createInvitation(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "create_admin_invitation", true, http.StatusCreated, func(work *http.Request, id string) (any, error) {
		fields, err := adminFields(w, work, "expectedUserId")
		if err != nil {
			return nil, err
		}
		expected, err := httpx.RequiredString(fields, "expectedUserId")
		if err != nil {
			return nil, err
		}
		result, err := h.operations.CreateAdminInvitation(work.Context(), p, id, expected)
		if err != nil {
			return nil, err
		}
		return api.CreatedGitHubAppAdminInvitation{GitHubAppAdminInvitation: adminInvitationResponse(result.Invitation), Link: h.origin + "/github-app-admin-invitations#" + result.Secret}, nil
	})
}
func (h *adminHandler) revokeInvitation(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "revoke_admin_invitation", true, http.StatusOK, func(work *http.Request, id string) (any, error) {
		inviteID, err := model.CanonicalID(work.PathValue("inviteId"))
		if err != nil {
			return nil, err
		}
		fields, err := adminFields(w, work, "expectedUserId")
		if err != nil {
			return nil, err
		}
		expected, err := httpx.RequiredString(fields, "expectedUserId")
		if err != nil {
			return nil, err
		}
		result, err := h.operations.RevokeAdminInvitation(work.Context(), p, id, inviteID, expected)
		if err != nil {
			return nil, err
		}
		return api.GitHubAppAdminInvitationRevocation{AppID: result.AppID, InvitationID: result.InvitationID, Changed: result.Changed}, nil
	})
}
func (h *adminHandler) inspectInvitation(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "inspect_admin_invitation", false, http.StatusOK, func(work *http.Request, _ string) (any, error) {
		fields, err := adminFields(w, work, "token")
		if err != nil {
			return nil, err
		}
		token, err := httpx.RequiredString(fields, "token")
		if err != nil {
			return nil, err
		}
		result, err := h.operations.InspectAdminInvitation(work.Context(), p, token)
		if err != nil {
			return nil, err
		}
		response := api.GitHubAppAdminInvitationInspection{App: api.GitHubAppIdentity{ID: result.App.ID, GitHubAppID: decimal(result.App.GitHubAppID), Name: result.App.Name, GitHubName: result.App.GitHubName, GitHubSlug: result.App.GitHubSlug}, ExpiresAt: result.ExpiresAt.UTC()}
		if result.Membership != nil {
			membership := adminMembershipResponse(*result.Membership)
			response.Membership = &membership
		}
		return response, nil
	})
}
func (h *adminHandler) acceptInvitation(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "accept_admin_invitation", true, http.StatusOK, func(work *http.Request, _ string) (any, error) {
		fields, err := adminFields(w, work, "token", "expectedUserId")
		if err != nil {
			return nil, err
		}
		token, err := httpx.RequiredString(fields, "token")
		if err != nil {
			return nil, err
		}
		expected, err := httpx.RequiredString(fields, "expectedUserId")
		if err != nil {
			return nil, err
		}
		result, err := h.operations.AcceptAdminInvitation(work.Context(), p, token, expected)
		if err != nil {
			return nil, err
		}
		return api.GitHubAppAdminInvitationAcceptance{AppID: result.AppID, Membership: adminMembershipResponse(result.Membership), Joined: result.Joined}, nil
	})
}
