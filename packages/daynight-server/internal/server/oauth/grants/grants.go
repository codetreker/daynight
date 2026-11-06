// Package grants adapts account-owned OAuth grant operations to HTTP.
package grants

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/google/uuid"
)

type lifecycle interface {
	ListSessionGrants(context.Context, model.Principal) ([]store.OAuthGrant, time.Time, error)
	RevokeSessionGrant(context.Context, model.Principal, string) (bool, error)
}

type routes struct {
	grants lifecycle
	auth   *authhttp.Authentication
	logger *slog.Logger
}

// RegisterRoutes binds owner operations to the existing browser authenticator.
func RegisterRoutes(mux *http.ServeMux, grants lifecycle, auth *authhttp.Authentication, logger *slog.Logger) {
	h := &routes{grants: grants, auth: auth, logger: logger}
	mux.HandleFunc("GET /api/v1/oauth/grants", h.session(h.list))
	mux.HandleFunc("POST /api/v1/oauth/grants/{id}/revoke", h.session(h.revoke))
	mux.HandleFunc("HEAD /api/v1/oauth/grants", h.session(httpx.ResourceMethodNotAllowed(logger, "GET")))
	mux.HandleFunc("/api/v1/oauth/grants", h.session(httpx.ResourceMethodNotAllowed(logger, "GET")))
	mux.HandleFunc("/api/v1/oauth/grants/{id}/revoke", h.session(httpx.ResourceMethodNotAllowed(logger, "POST")))
}

func (h *routes) session(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return h.auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		if p.Kind != model.SessionCredential || model.RequirePrincipal(p) != nil {
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

func (h *routes) list(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if r.URL.RawQuery != "" {
		httpx.WriteError(w, r, h.logger, "oauth_grants", "list", httpx.InvalidInput("Query parameters are not supported."))
		return
	}
	items, now, err := h.grants.ListSessionGrants(r.Context(), p)
	if err != nil {
		httpx.WriteError(w, r, h.logger, "oauth_grants", "list", err)
		return
	}
	views := make([]grantView, 0, len(items))
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
		views = append(views, grantView{ID: item.ID, ClientName: client.ClientName, ClientID: item.ClientID, Resource: item.Resource, Scope: item.Scope, CreatedAt: item.CreatedAt.UTC(), ExpiresAt: item.ExpiresAt.UTC(), RevokedAt: revokedAt, Status: status})
	}
	httpx.WriteJSON(w, r, h.logger, http.StatusOK, struct {
		UserID string      `json:"userId"`
		Grants []grantView `json:"grants"`
	}{p.UserID, views})
}

func (h *routes) revoke(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if r.URL.RawQuery != "" {
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
