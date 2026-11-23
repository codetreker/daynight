// Package grants adapts account-owned OAuth grant operations to HTTP.
package grants

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/credential"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/google/uuid"
)

type lifecycle interface {
	ListSessionGrants(context.Context, model.Principal) ([]store.OAuthGrant, time.Time, error)
	RevokeSessionGrant(context.Context, model.Principal, string) (bool, error)
	UpdateSessionGrantDescription(context.Context, model.Principal, string, string, *string, *string) (*string, error)
}

type routes struct {
	grants lifecycle
	scoped scopedManagement
	auth   *authhttp.Authentication
	logger *slog.Logger
}

// RegisterRoutes binds owner operations to the existing browser authenticator.
func RegisterRoutes(mux httpx.RouteRegistrar, grants lifecycle, auth *authhttp.Authentication, logger *slog.Logger) {
	registerRoutes(mux, grants, nil, auth, logger, nil)
}

type scopedManagement interface {
	ListSessionGrants(context.Context, model.Principal) ([]store.OAuthGrant, time.Time, error)
	UpdateSessionGrantScope(context.Context, model.Principal, string, string, int64, string, []scopepolicy.ScopeID) (store.OAuthGrant, time.Time, error)
}

// RegisterScopedRoutes opts into scoped grant reads and edits after migration.
func RegisterScopedRoutes(mux httpx.RouteRegistrar, grants lifecycle, scoped scopedManagement, auth *authhttp.Authentication, logger *slog.Logger) {
	RegisterScopedRoutesWithScopeObserver(mux, grants, scoped, auth, logger, nil)
}

// ScopeRoute records the classification attached to an actual grant route.
type ScopeRoute struct {
	Pattern               string
	BrowserOnly, Fallback bool
}

func RegisterScopedRoutesWithScopeObserver(mux httpx.RouteRegistrar, grants lifecycle, scoped scopedManagement, auth *authhttp.Authentication, logger *slog.Logger, observe func(ScopeRoute)) {
	registerRoutes(mux, grants, scoped, auth, logger, observe)
}

func registerRoutes(mux httpx.RouteRegistrar, grants lifecycle, scoped scopedManagement, auth *authhttp.Authentication, logger *slog.Logger, observe func(ScopeRoute)) {
	h := &routes{grants: grants, scoped: scoped, auth: auth, logger: logger}
	handle := func(pattern string, fn http.HandlerFunc, fallback bool) {
		mux.HandleFunc(pattern, fn)
		if observe != nil {
			observe(ScopeRoute{Pattern: pattern, BrowserOnly: true, Fallback: fallback})
		}
	}
	handle("GET /api/v1/oauth/grants", h.session(h.list), false)
	handle("GET /api/v2/oauth/grants", h.session(h.listV2), false)
	handle("GET /api/v3/oauth/grants", auth.RequireCredentialSession(h.listV3), false)
	handle("HEAD /api/v3/oauth/grants", auth.RequireCredentialSession(httpx.ResourceMethodNotAllowed(logger, "GET")), true)
	handle("/api/v3/oauth/grants", auth.RequireCredentialSession(httpx.ResourceMethodNotAllowed(logger, "GET")), true)
	handle("PATCH /api/v3/oauth/grants/{id}/description", auth.RequireCredentialSession(h.updateDescription), false)
	handle("/api/v3/oauth/grants/{id}/description", auth.RequireCredentialSession(httpx.ResourceMethodNotAllowed(logger, "PATCH")), true)
	if scoped != nil {
		handle("PATCH /api/v3/oauth/grants/{id}/scopes", auth.RequireCredentialSession(h.updateScopes), false)
		handle("/api/v3/oauth/grants/{id}/scopes", auth.RequireCredentialSession(httpx.ResourceMethodNotAllowed(logger, "PATCH")), true)
	}
	handle("HEAD /api/v2/oauth/grants", h.session(httpx.ResourceMethodNotAllowed(logger, "GET")), true)
	handle("/api/v2/oauth/grants", h.session(httpx.ResourceMethodNotAllowed(logger, "GET")), true)
	handle("POST /api/v1/oauth/grants/{id}/revoke", h.session(h.revoke), false)
	handle("HEAD /api/v1/oauth/grants", h.session(httpx.ResourceMethodNotAllowed(logger, "GET")), true)
	handle("/api/v1/oauth/grants", h.session(httpx.ResourceMethodNotAllowed(logger, "GET")), true)
	handle("/api/v1/oauth/grants/{id}/revoke", h.session(httpx.ResourceMethodNotAllowed(logger, "POST")), true)
}

func (h *routes) session(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return h.auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		if p.Kind != model.SessionCredential || model.RequirePrincipal(p) != nil {
			httpx.CloseUnreadBody(w, r)
			httpx.WriteError(w, r, h.logger, "oauth_grants", "session", &model.Fault{Code: "forbidden", Message: "A main-site browser session is required."})
			return
		}
		next(w, r, p)
	})
}

type grantView struct {
	ID         string     `json:"id"`
	ClientName string     `json:"clientName"`
	ClientID   string     `json:"clientId"`
	Resource   string     `json:"resource"`
	Scope      string     `json:"scope"`
	CreatedAt  time.Time  `json:"createdAt"`
	ExpiresAt  time.Time  `json:"expiresAt"`
	RevokedAt  *time.Time `json:"revokedAt"`
	Status     string     `json:"status"`
}

type grantViewV2 struct {
	grantView
	LastUsedAt *time.Time `json:"lastUsedAt"`
}

type grantViewV3 struct {
	grantViewV2
	Description *string `json:"description"`
}

type scopeView struct {
	Scopes       []scopepolicy.ScopeID `json:"scopes"`
	ScopeVersion string                `json:"scopeVersion"`
}

type scopedGrantView struct {
	grantViewV3
	ScopePolicy *scopeView `json:"scopePolicy"`
}

func scopedView(item store.OAuthGrant, view grantViewV3) scopedGrantView {
	var policy *scopeView
	if item.ScopePolicy != nil {
		policy = &scopeView{Scopes: item.ScopePolicy.Scopes(), ScopeVersion: strconv.FormatInt(item.ScopePolicy.Version(), 10)}
	}
	return scopedGrantView{grantViewV3: view, ScopePolicy: policy}
}

func (h *routes) list(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.listVersion(w, r, p, 1)
}

func (h *routes) listV2(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.listVersion(w, r, p, 2)
}

func (h *routes) listV3(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.listVersion(w, r, p, 3)
}

func (h *routes) listVersion(w http.ResponseWriter, r *http.Request, p model.Principal, version int) {
	if r.URL.RawQuery != "" || version == 3 && r.URL.ForceQuery {
		httpx.WriteError(w, r, h.logger, "oauth_grants", "list", httpx.InvalidInput("Query parameters are not supported."))
		return
	}
	ctx := r.Context()
	if version == 3 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
	}
	reader := h.grants.ListSessionGrants
	if version == 3 && h.scoped != nil {
		reader = h.scoped.ListSessionGrants
	}
	items, now, err := reader(ctx, p)
	if err != nil {
		if version == 3 {
			credential.WriteReadError(w, r, h.logger.With("user_id", p.UserID), "oauth_grants", "list", err)
		} else {
			httpx.WriteError(w, r, h.logger, "oauth_grants", "list", err)
		}
		return
	}
	views := make([]grantView, 0, len(items))
	viewsV2 := make([]grantViewV2, 0, len(items))
	viewsV3 := make([]grantViewV3, 0, len(items))
	scopedViews := make([]scopedGrantView, 0, len(items))
	for _, item := range items {
		var client core.ValidatedClient
		if err := json.Unmarshal(item.ClientSnapshot, &client); err != nil || client.ClientID != item.ClientID {
			httpx.WriteError(w, r, h.logger, "oauth_grants", "client_snapshot", fmt.Errorf("invalid stored OAuth client snapshot"))
			return
		}
		status := "active"
		if item.RevokedAt != nil {
			status = "revoked"
		} else if !item.ExpiresAt.After(now) {
			status = "expired"
		}
		var revokedAt *time.Time
		if item.RevokedAt != nil {
			stamp := item.RevokedAt.UTC()
			revokedAt = &stamp
		}
		view := grantView{ID: item.ID, ClientName: client.ClientName, ClientID: item.ClientID, Resource: item.Resource, Scope: item.Scope, CreatedAt: item.CreatedAt.UTC(), ExpiresAt: item.ExpiresAt.UTC(), RevokedAt: revokedAt, Status: status}
		if version >= 2 {
			var usedAt *time.Time
			if item.LastUsedAt != nil {
				stamp := item.LastUsedAt.UTC()
				usedAt = &stamp
			}
			if version == 3 {
				v3 := grantViewV3{grantViewV2: grantViewV2{grantView: view, LastUsedAt: usedAt}, Description: item.Description}
				viewsV3 = append(viewsV3, v3)
				scopedViews = append(scopedViews, scopedView(item, v3))
			} else {
				viewsV2 = append(viewsV2, grantViewV2{grantView: view, LastUsedAt: usedAt})
			}
		} else {
			views = append(views, view)
		}
	}
	if version == 3 {
		if h.scoped != nil {
			httpx.WriteJSON(w, r, h.logger, http.StatusOK, struct {
				UserID string            `json:"userId"`
				Grants []scopedGrantView `json:"grants"`
			}{p.UserID, scopedViews})
			return
		}
		httpx.WriteJSON(w, r, h.logger, http.StatusOK, struct {
			UserID string        `json:"userId"`
			Grants []grantViewV3 `json:"grants"`
		}{p.UserID, viewsV3})
		return
	}
	if version == 2 {
		httpx.WriteJSON(w, r, h.logger, http.StatusOK, struct {
			UserID string        `json:"userId"`
			Grants []grantViewV2 `json:"grants"`
		}{p.UserID, viewsV2})
		return
	}
	httpx.WriteJSON(w, r, h.logger, http.StatusOK, struct {
		UserID string      `json:"userId"`
		Grants []grantView `json:"grants"`
	}{p.UserID, views})
}

func (h *routes) revoke(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if r.URL.RawQuery != "" {
		httpx.CloseUnreadBody(w, r)
		httpx.WriteError(w, r, h.logger, "oauth_grants", "revoke", httpx.InvalidInput("Query parameters are not supported."))
		return
	}
	fields, err := httpx.DecodeObject(w, r, "expectedUserId")
	if err == nil {
		var expected string
		expected, err = httpx.RequiredString(fields, "expectedUserId")
		if err == nil {
			id, parseErr := uuid.Parse(expected)
			if parseErr != nil || id == uuid.Nil || id.String() != expected {
				err = httpx.InvalidInput("expectedUserId must be a canonical user ID.")
			} else if expected != p.UserID {
				err = &model.Fault{Code: "identity_mismatch", Message: "The current account differs from the expected account."}
			}
		}
	}
	if err != nil {
		httpx.WriteError(w, r, h.logger, "oauth_grants", "revoke", err)
		return
	}
	changed, err := h.grants.RevokeSessionGrant(r.Context(), p, r.PathValue("id"))
	if errors.Is(err, core.ErrAuthorizationUnknown) {
		err = &model.Fault{Code: "write_outcome_unknown", Message: "The revocation outcome is unknown. Read the current grant state."}
	} else if errors.Is(err, model.ErrNotFound) {
		err = &model.Fault{Code: "not_found", Message: "Grant not found."}
	}
	if err != nil {
		httpx.WriteError(w, r, h.logger, "oauth_grants", "revoke", err)
		return
	}
	httpx.WriteJSON(w, r, h.logger, http.StatusOK, struct {
		Changed bool `json:"changed"`
	}{changed})
}

func (h *routes) updateDescription(w http.ResponseWriter, r *http.Request, p model.Principal) {
	fields, err := credential.Fields(w, r, "expectedUserId", "expectedDescription", "description")
	var expectedUser string
	var expected, description *string
	if err == nil {
		expectedUser, err = credential.ExpectedUser(fields, p)
	}
	if err == nil {
		expected, err = credential.NullableDescription(fields, "expectedDescription", true)
	}
	if err == nil {
		description, err = credential.NullableDescription(fields, "description", true)
	}
	if err != nil {
		httpx.WriteError(w, r, h.logger, "oauth_grants", "update_description", err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	id := r.PathValue("id")
	if err := credential.TargetID(id); err != nil {
		httpx.WriteError(w, r, h.logger, "oauth_grants", "update_description", err)
		return
	}
	result, err := h.grants.UpdateSessionGrantDescription(ctx, p, expectedUser, id, expected, description)
	logger := h.logger.With("user_id", p.UserID, "grant_id", id)
	if err != nil {
		credential.WriteOperationError(w, r, logger, "oauth_grants", "update_description", err, errors.Is(err, core.ErrAuthorizationUnknown))
		return
	}
	httpx.WriteMutationJSON(w, r, logger, "oauth_grants", http.StatusOK, credential.DescriptionResponse{ID: id, Description: result})
}
