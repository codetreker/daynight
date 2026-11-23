package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	credentialhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/credential"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

// ScopedPATOperations uses the same immutable catalog as device approval.
type ScopedPATOperations interface {
	DeviceScopeCatalog() (scopepolicy.CatalogSnapshot, bool)
	ListScopedPATs(context.Context, model.Principal) ([]model.PersonalAccessToken, error)
	CreateScopedPAT(context.Context, model.Principal, string, identitycore.CreatePAT, *string, string, []scopepolicy.ScopeID) (identitycore.MintedPAT, error)
	UpdateScopedPAT(context.Context, model.Principal, string, string, int64, string, []scopepolicy.ScopeID) (model.PersonalAccessToken, error)
}

type patScopeView struct {
	Scopes       []scopepolicy.ScopeID `json:"scopes"`
	ScopeVersion string                `json:"scopeVersion"`
}
type scopedTokenView struct {
	tokenViewV2
	ScopePolicy patScopeView `json:"scopePolicy"`
}

func scopedTokenResponse(token model.PersonalAccessToken) (scopedTokenView, error) {
	policy := token.ScopePolicy
	if policy == nil || policy.Kind() != scopepolicy.PAT || policy.Version() < 1 {
		return scopedTokenView{}, fmt.Errorf("invalid PAT scope policy")
	}
	return scopedTokenView{tokenViewV2: tokenResponseV2(token), ScopePolicy: patScopeView{Scopes: policy.Scopes(), ScopeVersion: strconv.FormatInt(policy.Version(), 10)}}, nil
}

func (h *Authentication) listScopedTokens(ops ScopedPATOperations) httpx.AuthenticatedHandler {
	return func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		if err := credentialhttp.NoQuery(r); err != nil {
			httpx.WriteError(w, r, h.logger, "credential", "list_tokens", err)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		tokens, err := ops.ListScopedPATs(ctx, p)
		if err != nil {
			credentialhttp.WriteReadError(w, r, h.logger.With("user_id", p.UserID), "credential", "list_tokens", err)
			return
		}
		views := make([]scopedTokenView, 0, len(tokens))
		for _, token := range tokens {
			view, err := scopedTokenResponse(token)
			if err != nil {
				credentialhttp.WriteReadError(w, r, h.logger, "credential", "list_tokens", err)
				return
			}
			views = append(views, view)
		}
		httpx.WriteJSON(w, r, h.logger, http.StatusOK, struct {
			Items []scopedTokenView `json:"items"`
		}{views})
	}
}

func selectedScopes(fields map[string]json.RawMessage) (string, []scopepolicy.ScopeID, error) {
	revision, err := httpx.RequiredString(fields, "catalogRevision")
	if err != nil || revision == "" {
		return "", nil, httpx.InvalidInput("catalogRevision is required")
	}
	values, err := httpx.OptionalStrings(fields, "scopes")
	if err != nil {
		return "", nil, err
	}
	if values == nil || len(*values) == 0 {
		return "", nil, httpx.InvalidInput("at least one scope is required")
	}
	ids := make([]scopepolicy.ScopeID, 0, len(*values))
	for _, value := range *values {
		ids = append(ids, scopepolicy.ScopeID(value))
	}
	return revision, ids, nil
}

func (h *Authentication) createScopedToken(ops ScopedPATOperations) httpx.AuthenticatedHandler {
	return func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		fields, err := credentialhttp.Fields(w, r, "expectedUserId", "name", "expiresAt", "description", "catalogRevision", "scopes")
		var expected, name, revision string
		var expires *time.Time
		var description *string
		var ids []scopepolicy.ScopeID
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
		if err == nil {
			revision, ids, err = selectedScopes(fields)
		}
		if err != nil {
			httpx.WriteError(w, r, h.logger, "credential", "create_token", err)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		result, err := ops.CreateScopedPAT(ctx, p, expected, identitycore.CreatePAT{Name: name, ExpiresAt: expires}, description, revision, ids)
		logger := h.logger.With("user_id", p.UserID)
		if err != nil {
			credentialhttp.WriteOperationError(w, r, logger, "credential", "create_token", err, false)
			return
		}
		view, err := scopedTokenResponse(result.Credential)
		if err != nil {
			credentialhttp.WriteOperationError(w, r, logger, "credential", "create_token", err, false)
			return
		}
		w.Header().Set("Location", "/api/v1/me/tokens/"+result.Credential.ID)
		httpx.WriteMutationJSON(w, r, logger.With("credential_id", result.Credential.ID), "credential", http.StatusCreated, struct {
			scopedTokenView
			Token string `json:"token"`
		}{view, result.Secret})
	}
}

func (h *Authentication) updateScopedToken(ops ScopedPATOperations) httpx.AuthenticatedHandler {
	return func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		fields, err := credentialhttp.Fields(w, r, "expectedUserId", "expectedScopeVersion", "catalogRevision", "scopes")
		var expected, revision, rawVersion string
		var version int64
		var ids []scopepolicy.ScopeID
		if err == nil {
			expected, err = credentialhttp.ExpectedUser(fields, p)
		}
		if err == nil {
			rawVersion, err = httpx.RequiredString(fields, "expectedScopeVersion")
		}
		if err == nil {
			version, err = strconv.ParseInt(rawVersion, 10, 64)
			if err != nil || version < 1 || strconv.FormatInt(version, 10) != rawVersion {
				err = httpx.InvalidInput("expectedScopeVersion must be a positive decimal int64 string")
			}
		}
		if err == nil {
			revision, ids, err = selectedScopes(fields)
		}
		id := r.PathValue("tokenId")
		if err == nil {
			err = credentialhttp.TargetID(id)
		}
		if err != nil {
			httpx.WriteError(w, r, h.logger, "credential", "update_token_scopes", err)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		result, err := ops.UpdateScopedPAT(ctx, p, id, expected, version, revision, ids)
		logger := h.logger.With("user_id", p.UserID, "credential_id", id)
		if err != nil {
			credentialhttp.WriteOperationError(w, r, logger, "credential", "update_token_scopes", err, false)
			return
		}
		view, err := scopedTokenResponse(result)
		if err != nil {
			credentialhttp.WriteOperationError(w, r, logger, "credential", "update_token_scopes", err, false)
			return
		}
		httpx.WriteMutationJSON(w, r, logger, "credential", http.StatusOK, view)
	}
}
