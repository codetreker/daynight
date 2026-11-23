package auth

import (
	"context"
	"errors"
	"net/http"
	"time"

	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	credentialhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/credential"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

// ScopedDeviceOperations operates on the same catalog snapshot exposed to the browser.
type ScopedDeviceOperations interface {
	DeviceScopeCatalog() (scopepolicy.CatalogSnapshot, bool)
	InspectDeviceV2(context.Context, model.Principal, string) (identitycore.DeviceInspectionV2, error)
	DecideDeviceV2(context.Context, model.Principal, string, string, string, string, []scopepolicy.ScopeID) error
}

// RegisterScopedDeviceRoutes uses the same identity service as the v1 token
// endpoint so a scoped approval cannot be redeemed by the legacy issuer.
func (h *Authentication) RegisterScopedDeviceRoutes(mux httpx.RouteRegistrar, mcp scopepolicy.CatalogSnapshot) error {
	return h.RegisterScopedDeviceRoutesWithScopeObserver(mux, mcp, nil)
}

// RegisterScopedDeviceRoutesWithScopeObserver reports the actual browser-only
// registrations and their method fallbacks for scope route reconciliation.
func (h *Authentication) RegisterScopedDeviceRoutesWithScopeObserver(mux httpx.RouteRegistrar, mcp scopepolicy.CatalogSnapshot, observe func(ScopeRoute)) error {
	identity, ok := h.identity.(ScopedDeviceOperations)
	if !ok {
		return errors.New("identity service does not support scoped device authorization")
	}
	pat, enabled := identity.DeviceScopeCatalog()
	if !enabled {
		return errors.New("scoped device authorization is not enabled")
	}
	pat, mcp = pat.Clone(), mcp.Clone()
	routes := accountRouteRegistry{mux: mux, observe: observe}
	require := h.RequireCredentialSession
	catalog := "/api/v1/me/credential-scope-catalog"
	routes.handle("GET "+catalog, require(func(w http.ResponseWriter, r *http.Request, _ model.Principal) {
		if err := credentialhttp.NoQuery(r); err != nil {
			httpx.WriteError(w, r, h.logger, "credential", "scope_catalog", err)
			return
		}
		httpx.WriteJSON(w, r, h.logger, http.StatusOK, struct {
			PAT scopepolicy.CatalogSnapshot `json:"pat"`
			MCP scopepolicy.CatalogSnapshot `json:"mcp"`
		}{pat.Clone(), mcp.Clone()})
	}), accountBrowser, false)
	routes.handle("HEAD "+catalog, require(httpx.ResourceMethodNotAllowed(h.logger, "GET")), accountBrowserFallback, false)
	routes.handle(catalog, require(httpx.ResourceMethodNotAllowed(h.logger, "GET")), accountBrowserFallback, false)
	for _, route := range []struct {
		path string
		fn   httpx.AuthenticatedHandler
	}{
		{"/api/v2/auth/device/inspect", h.scopedDeviceInspect(identity)},
		{"/api/v2/auth/device/decision", h.scopedDeviceDecision(identity)},
	} {
		routes.handle("POST "+route.path, require(route.fn), accountBrowser, false)
		routes.handle(route.path, require(httpx.ResourceMethodNotAllowed(h.logger, "POST")), accountBrowserFallback, false)
	}
	return nil
}

func (h *Authentication) scopedDeviceInspect(identity ScopedDeviceOperations) httpx.AuthenticatedHandler {
	return func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		fields, err := credentialhttp.Fields(w, r, "userCode")
		var code string
		if err == nil {
			code, err = httpx.RequiredString(fields, "userCode")
		}
		if err != nil {
			httpx.WriteError(w, r, h.logger, "auth", "device_inspect", err)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		result, err := identity.InspectDeviceV2(ctx, p, code)
		if err != nil {
			credentialhttp.WriteReadError(w, r, h.logger, "auth", "device_inspect", err)
			return
		}
		httpx.WriteJSON(w, r, h.logger, http.StatusOK, result)
	}
}

func (h *Authentication) scopedDeviceDecision(identity ScopedDeviceOperations) httpx.AuthenticatedHandler {
	return func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		fields, err := credentialhttp.Fields(w, r, "userCode", "decision", "expectedUserId", "catalogRevision", "scopes")
		var code, decision, expected, revision string
		var scopes []scopepolicy.ScopeID
		if err == nil {
			code, err = httpx.RequiredString(fields, "userCode")
		}
		if err == nil {
			decision, err = httpx.RequiredString(fields, "decision")
		}
		if err == nil {
			expected, err = credentialhttp.ExpectedUser(fields, p)
		}
		if err == nil {
			switch decision {
			case "approve":
				revision, err = httpx.RequiredString(fields, "catalogRevision")
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
			case "deny":
				if _, present := fields["scopes"]; present {
					err = httpx.InvalidInput("scopes are not allowed for denial")
				} else if _, present := fields["catalogRevision"]; present {
					err = httpx.InvalidInput("catalogRevision is not allowed for denial")
				}
			default:
				err = httpx.InvalidInput("decision must be approve or deny")
			}
		}
		if err != nil {
			httpx.WriteError(w, r, h.logger, "auth", "device_decision", err)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		if err := identity.DecideDeviceV2(ctx, p, code, decision, expected, revision, scopes); err != nil {
			credentialhttp.WriteOperationError(w, r, h.logger, "auth", "device_decision", err, false)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
