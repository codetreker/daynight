package auth

import (
	"context"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	credentialhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/credential"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type tokenViewV2 struct {
	api.PersonalAccessToken
	Description *string `json:"description"`
}

func tokenResponseV2(token model.PersonalAccessToken) tokenViewV2 {
	return tokenViewV2{PersonalAccessToken: tokenResponse(token), Description: token.Description}
}

func (h *Authentication) registerCredentialRoutes(routes accountRouteRegistry) {
	require := h.RequireCredentialSession
	routes.handle("GET /api/v2/me/tokens", require(h.listTokensV2), accountBrowser, false)
	routes.handle("POST /api/v2/me/tokens", require(h.createTokenV2), accountBrowser, false)
	routes.handle("HEAD /api/v2/me/tokens", require(httpx.ResourceMethodNotAllowed(h.logger, "GET, POST")), accountBrowserFallback, false)
	routes.handle("/api/v2/me/tokens", require(httpx.ResourceMethodNotAllowed(h.logger, "GET, POST")), accountBrowserFallback, false)
	routes.handle("PATCH /api/v2/me/tokens/{tokenId}/description", require(h.updateTokenDescription), accountBrowser, false)
	routes.handle("/api/v2/me/tokens/{tokenId}/description", require(httpx.ResourceMethodNotAllowed(h.logger, "PATCH")), accountBrowserFallback, false)
}

func (h *Authentication) listTokensV2(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if err := credentialhttp.NoQuery(r); err != nil {
		httpx.WriteError(w, r, h.logger, "credential", "list_tokens", err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	tokens, err := h.identity.ListPATsV2(ctx, p)
	if err != nil {
		credentialhttp.WriteReadError(w, r, h.logger.With("user_id", p.UserID), "credential", "list_tokens", err)
		return
	}
	views := make([]tokenViewV2, 0, len(tokens))
	for _, token := range tokens {
		views = append(views, tokenResponseV2(token))
	}
	httpx.WriteJSON(w, r, h.logger, http.StatusOK, struct {
		Items []tokenViewV2 `json:"items"`
	}{views})
}

func (h *Authentication) createTokenV2(w http.ResponseWriter, r *http.Request, p model.Principal) {
	fields, err := credentialhttp.Fields(w, r, "expectedUserId", "name", "expiresAt", "description")
	var expected, name string
	var expires *time.Time
	var description *string
	if err == nil {
		expected, err = credentialhttp.ExpectedUser(fields, p)
	}
	if err == nil {
		name, err = httpx.RequiredString(fields, "name")
	}
	if err == nil {
		expires, err = requiredTokenTimestamp(fields, "expiresAt")
	}
	if err == nil {
		description, err = credentialhttp.NullableDescription(fields, "description", false)
	}
	if err != nil {
		httpx.WriteError(w, r, h.logger, "credential", "create_token", err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	result, err := h.identity.CreatePATV2(ctx, p, expected, identitycore.CreatePAT{Name: name, ExpiresAt: expires}, description)
	logger := h.logger.With("user_id", p.UserID)
	if err != nil {
		credentialhttp.WriteOperationError(w, r, logger, "credential", "create_token", err, false)
		return
	}
	w.Header().Set("Location", "/api/v1/me/tokens/"+result.Credential.ID)
	httpx.WriteMutationJSON(w, r, logger.With("credential_id", result.Credential.ID), "credential", http.StatusCreated, struct {
		tokenViewV2
		Token string `json:"token"`
	}{tokenResponseV2(result.Credential), result.Secret})
}

func (h *Authentication) updateTokenDescription(w http.ResponseWriter, r *http.Request, p model.Principal) {
	fields, err := credentialhttp.Fields(w, r, "expectedUserId", "expectedDescription", "description")
	var expectedUser string
	var expected, description *string
	if err == nil {
		expectedUser, err = credentialhttp.ExpectedUser(fields, p)
	}
	if err == nil {
		expected, err = credentialhttp.NullableDescription(fields, "expectedDescription", true)
	}
	if err == nil {
		description, err = credentialhttp.NullableDescription(fields, "description", true)
	}
	if err != nil {
		httpx.WriteError(w, r, h.logger, "credential", "update_token_description", err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	id := r.PathValue("tokenId")
	if err := credentialhttp.TargetID(id); err != nil {
		httpx.WriteError(w, r, h.logger, "credential", "update_token_description", err)
		return
	}
	actualID, actual, err := h.identity.UpdatePATDescription(ctx, p, id, expectedUser, expected, description)
	logger := h.logger.With("user_id", p.UserID, "credential_id", id)
	if err != nil {
		credentialhttp.WriteOperationError(w, r, logger, "credential", "update_token_description", err, false)
		return
	}
	httpx.WriteMutationJSON(w, r, logger, "credential", http.StatusOK, credentialhttp.DescriptionResponse{ID: actualID, Description: actual})
}
