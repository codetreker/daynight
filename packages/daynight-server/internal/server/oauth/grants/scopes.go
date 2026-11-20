package grants

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/credential"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func (h *routes) updateScopes(w http.ResponseWriter, r *http.Request, p model.Principal) {
	fields, err := credential.Fields(w, r, "expectedUserId", "expectedScopeVersion", "catalogRevision", "scopes")
	var expectedUser, versionText, revision string
	var version int64
	var scopes []scopepolicy.ScopeID
	if err == nil {
		expectedUser, err = credential.ExpectedUser(fields, p)
	}
	if err == nil {
		versionText, err = httpx.RequiredString(fields, "expectedScopeVersion")
	}
	if err == nil {
		version, err = strconv.ParseInt(versionText, 10, 64)
		if err != nil || version < 1 || strconv.FormatInt(version, 10) != versionText {
			err = httpx.InvalidInput("expectedScopeVersion must be a canonical positive integer string")
		}
	}
	if err == nil {
		revision, err = httpx.RequiredString(fields, "catalogRevision")
	}
	if err == nil && revision == "" {
		err = httpx.InvalidInput("catalogRevision is required")
	}
	if err == nil {
		var values *[]string
		values, err = httpx.OptionalStrings(fields, "scopes")
		if err == nil && (values == nil || len(*values) == 0) {
			err = httpx.InvalidInput("at least one scope is required")
		}
		if err == nil {
			for _, value := range *values {
				scopes = append(scopes, scopepolicy.ScopeID(value))
			}
		}
	}
	id := r.PathValue("id")
	if err == nil {
		err = credential.TargetID(id)
	}
	if err != nil {
		httpx.WriteError(w, r, h.logger, "oauth_grants", "update_scopes", err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	result, _, err := h.scoped.UpdateSessionGrantScope(ctx, p, expectedUser, id, version, revision, scopes)
	logger := h.logger.With("user_id", p.UserID, "grant_id", id)
	if err != nil {
		credential.WriteOperationError(w, r, logger, "oauth_grants", "update_scopes", err, errors.Is(err, core.ErrAuthorizationUnknown))
		return
	}
	var client core.ValidatedClient
	if err := json.Unmarshal(result.ClientSnapshot, &client); err != nil || client.ClientID != result.ClientID || result.ScopePolicy == nil {
		credential.WriteOperationError(w, r, logger, "oauth_grants", "update_scopes", fmt.Errorf("invalid committed grant projection"), false)
		return
	}
	view := grantView{ID: result.ID, ClientName: client.ClientName, ClientID: result.ClientID, Resource: result.Resource, Scope: result.Scope, CreatedAt: result.CreatedAt.UTC(), ExpiresAt: result.ExpiresAt.UTC(), Status: "active"}
	if result.LastUsedAt != nil {
		stamp := result.LastUsedAt.UTC()
		result.LastUsedAt = &stamp
	}
	v3 := grantViewV3{grantViewV2: grantViewV2{grantView: view, LastUsedAt: result.LastUsedAt}, Description: result.Description}
	httpx.WriteMutationJSON(w, r, logger, "oauth_grants", http.StatusOK, scopedView(result, v3))
}
