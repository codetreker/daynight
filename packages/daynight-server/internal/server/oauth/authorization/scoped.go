package authorization

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	credentialhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/credential"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
)

// ScopedAuthorizationService uses one catalog for browser decisions and issuance.
type ScopedAuthorizationService interface {
	ScopeCatalog() (scopepolicy.CatalogSnapshot, bool)
	InspectV2(context.Context, string, string, model.Principal) (service.AuthorizationViewV2, error)
	DecideV2(context.Context, service.ScopedDecisionInput) (service.DecisionResult, error)
}

type browserSessionAuthentication interface {
	AuthenticateSessionRequest(*http.Request) (model.Principal, error)
}

// ScopeRoute identifies actual browser-only registrations and method fallbacks.
type ScopeRoute struct {
	Pattern               string
	BrowserOnly, Fallback bool
}

func (h *AuthorizationHTTP) RegisterScopedRoutes(mux *http.ServeMux) error {
	return h.RegisterScopedRoutesWithScopeObserver(mux, nil)
}

// RegisterScopedRoutesWithScopeObserver keeps the v2 surface opt-in until the
// scoped issuer and matching browser catalog are assembled together.
func (h *AuthorizationHTTP) RegisterScopedRoutesWithScopeObserver(mux *http.ServeMux, observe func(ScopeRoute)) error {
	scoped, ok := h.service.(ScopedAuthorizationService)
	if !ok {
		return errors.New("authorization service does not support scoped approval")
	}
	if _, enabled := scoped.ScopeCatalog(); !enabled {
		return errors.New("scoped authorization is not enabled")
	}
	auth, ok := h.auth.(browserSessionAuthentication)
	if !ok {
		return errors.New("browser authentication does not support session-only admission")
	}
	register := func(pattern string, handler httpx.AuthenticatedHandler, fallback bool) {
		mux.HandleFunc(pattern, h.scopedSession(auth, handler))
		if observe != nil {
			observe(ScopeRoute{Pattern: pattern, BrowserOnly: true, Fallback: fallback})
		}
	}
	inspect := "/api/v2/oauth/requests/{id}"
	decision := inspect + "/decision"
	register("GET "+inspect, h.inspectV2(scoped), false)
	register("HEAD "+inspect, httpx.ResourceMethodNotAllowed(slog.Default(), "GET"), true)
	register(inspect, httpx.ResourceMethodNotAllowed(slog.Default(), "GET"), true)
	register("POST "+decision, h.decideV2(scoped), false)
	register(decision, httpx.ResourceMethodNotAllowed(slog.Default(), "POST"), true)
	return nil
}

func (h *AuthorizationHTTP) scopedSession(auth browserSessionAuthentication, next httpx.AuthenticatedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r = r.WithContext(httpx.WithRedactedOperationDiagnostics(r.Context()))
		safeHeaders(w)
		for name := range r.Header {
			if strings.EqualFold(name, "Authorization") {
				httpx.CloseUnreadBody(w, r)
				httpx.WriteError(w, r, slog.Default(), "oauth", "authenticate", &model.Fault{Code: "forbidden", Message: "A main-site browser session is required."})
				return
			}
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		p, err := auth.AuthenticateSessionRequest(r.WithContext(ctx))
		cancel()
		if err == nil && (p.Kind != model.SessionCredential || model.RequirePrincipal(p) != nil) {
			err = model.Unauthenticated(nil)
		}
		if err != nil {
			httpx.CloseUnreadBody(w, r)
			credentialhttp.WriteReadError(w, r, slog.Default(), "oauth", "authenticate", err)
			return
		}
		w.Header().Set("Daynight-User-ID", p.UserID)
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
			origins := r.Header.Values("Origin")
			if len(origins) != 1 || origins[0] != h.auth.Origin() {
				httpx.CloseUnreadBody(w, r)
				httpx.WriteError(w, r, slog.Default(), "oauth", "origin", &model.Fault{Code: "forbidden", Message: "Cookie writes require the exact main-site Origin."})
				return
			}
		}
		next(w, r, p)
	}
}

func (h *AuthorizationHTTP) scopedBinding(r *http.Request) (string, string, error) {
	id := r.PathValue("id")
	binding, ok := h.binding(r, id)
	if !validID(id) || !ok {
		return "", "", &model.Fault{Code: "not_found", Message: "Authorization request was not found."}
	}
	return id, binding, nil
}

func (h *AuthorizationHTTP) inspectV2(scoped ScopedAuthorizationService) httpx.AuthenticatedHandler {
	return func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		if err := credentialhttp.NoQuery(r); err != nil {
			httpx.WriteError(w, r, slog.Default(), "oauth", "inspect", err)
			return
		}
		id, binding, err := h.scopedBinding(r)
		if err != nil {
			httpx.WriteError(w, r, slog.Default(), "oauth", "inspect", err)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		view, err := scoped.InspectV2(ctx, id, binding, p)
		if err != nil {
			credentialhttp.WriteReadError(w, r, slog.Default(), "oauth", "inspect", scopedAuthorizationError(err))
			return
		}
		httpx.WriteJSON(w, r, slog.Default(), http.StatusOK, view)
	}
}

func (h *AuthorizationHTTP) decideV2(scoped ScopedAuthorizationService) httpx.AuthenticatedHandler {
	return func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		id, binding, err := h.scopedBinding(r)
		if err != nil {
			httpx.CloseUnreadBody(w, r)
			httpx.WriteError(w, r, slog.Default(), "oauth", "decision", err)
			return
		}
		in, err := scopedDecision(w, r, p)
		if err != nil {
			httpx.WriteError(w, r, slog.Default(), "oauth", "decision", err)
			return
		}
		in.RequestID, in.Binding = id, binding
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		result, err := scoped.DecideV2(ctx, in)
		if err != nil {
			credentialhttp.WriteOperationError(w, r, slog.Default(), "oauth", "decision", scopedAuthorizationError(err), errors.Is(err, core.ErrAuthorizationUnknown))
			return
		}
		httpx.WriteJSON(w, r, slog.Default(), http.StatusOK, struct {
			RedirectURI string `json:"redirectUri"`
		}{result.RedirectURI})
	}
}

func scopedDecision(w http.ResponseWriter, r *http.Request, p model.Principal) (service.ScopedDecisionInput, error) {
	in := service.ScopedDecisionInput{DecisionInput: service.DecisionInput{Principal: p}}
	fields, err := credentialhttp.Fields(w, r, "expectedUserId", "decision", "catalogRevision", "scopes")
	if err != nil {
		return in, err
	}
	in.ExpectedUserID, err = credentialhttp.ExpectedUser(fields, p)
	if err != nil {
		return in, err
	}
	in.Decision, err = httpx.RequiredString(fields, "decision")
	if err != nil {
		return in, err
	}
	switch in.Decision {
	case "approve":
		in.CatalogRevision, err = httpx.RequiredString(fields, "catalogRevision")
		if err != nil {
			return in, err
		}
		if in.CatalogRevision == "" {
			return in, httpx.InvalidInput("catalogRevision is required")
		}
		values, err := httpx.OptionalStrings(fields, "scopes")
		if err != nil {
			return in, err
		}
		if values == nil || len(*values) == 0 {
			return in, httpx.InvalidInput("at least one scope is required")
		}
		for _, value := range *values {
			in.Scopes = append(in.Scopes, scopepolicy.ScopeID(value))
		}
	case "deny":
		if _, present := fields["scopes"]; present {
			return in, httpx.InvalidInput("scopes are not allowed for denial")
		}
		if _, present := fields["catalogRevision"]; present {
			return in, httpx.InvalidInput("catalogRevision is not allowed for denial")
		}
	default:
		return in, httpx.InvalidInput("decision must be approve or deny")
	}
	return in, nil
}

func scopedAuthorizationError(err error) error {
	switch {
	case errors.Is(err, core.ErrInvalidAuthorization):
		return &model.Fault{Code: "invalid_input", Message: "Invalid OAuth authorization request.", Cause: err}
	case errors.Is(err, core.ErrRateLimited):
		return &model.Fault{Code: "rate_limited", Message: "Too many authorization requests.", Cause: err}
	default:
		return err
	}
}
