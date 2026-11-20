// Package prompt adapts personal prompt resources to HTTP.
package prompt

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

type prompts interface {
	Get(context.Context, model.Principal, model.PromptScope, string) (model.PromptResource, error)
	Put(context.Context, model.Principal, model.PromptScope, string, string, string, string) (model.PromptResource, error)
	GetReviewer(context.Context, model.Principal, model.PromptScope, string) (model.PromptResource, error)
	PutReviewer(context.Context, model.Principal, model.PromptScope, string, string, string, string) (model.PromptResource, error)
}

type handler struct {
	prompts         prompts
	logger          *slog.Logger
	bodyReadTimeout time.Duration
}

func newHandler(prompts prompts, logger *slog.Logger) *handler {
	return &handler{prompts: prompts, logger: logger, bodyReadTimeout: transport.JSONBodyReadTimeout}
}

type authenticator interface {
	Require(httpx.AuthenticatedHandler) http.HandlerFunc
}

// ScopedAuthentication supplies an authenticated current credential policy.
type ScopedAuthentication interface {
	RequireScoped(func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc
}

// ScopedPrompts applies policy and existing resource checks at the business boundary.
type ScopedPrompts interface {
	GetAuthorized(context.Context, model.CredentialAuthorization, model.PromptScope, string) (model.PromptResource, error)
	PutAuthorized(context.Context, model.CredentialAuthorization, model.PromptScope, string, string, string, string) (model.PromptResource, error)
	GetReviewerAuthorized(context.Context, model.CredentialAuthorization, model.PromptScope, string) (model.PromptResource, error)
	PutReviewerAuthorized(context.Context, model.CredentialAuthorization, model.PromptScope, string, string, string, string) (model.PromptResource, error)
}

// RegisterScopedRoutes installs policy-aware prompt routes. Authentication must
// retain the original credential, resource-profile and Origin checks.
func RegisterScopedRoutes(mux *http.ServeMux, prompts ScopedPrompts, auth ScopedAuthentication, logger *slog.Logger, observe func(ScopeRoute)) {
	if prompts == nil || auth == nil {
		panic("scoped prompt dependencies are required")
	}
	newHandler(nil, logger).registerScopedRoutes(mux, auth, prompts, observe)
}

// RegisterRoutes exposes Worker and Reviewer prompt resources.
func RegisterRoutes(mux *http.ServeMux, prompts prompts, auth authenticator, logger *slog.Logger) {
	RegisterRoutesWithScopeObserver(mux, prompts, auth, logger, nil)
}

// RegisterRoutesWithScopeObserver reports classifications from actual registrations.
func RegisterRoutesWithScopeObserver(mux *http.ServeMux, prompts prompts, auth authenticator, logger *slog.Logger, observe func(ScopeRoute)) {
	newHandler(prompts, logger).registerRoutesObserved(mux, auth, observe)
}

func (h *handler) registerRoutes(mux *http.ServeMux, auth authenticator) {
	h.registerRoutesObserved(mux, auth, nil)
}

func (h *handler) registerRoutesObserved(mux *http.ServeMux, auth authenticator, observe func(ScopeRoute)) {
	h.registerCommonRoutes(mux, observe, func(scope model.PromptScope, reviewer bool) http.HandlerFunc {
		return auth.Require(func(w http.ResponseWriter, r *http.Request, principal model.Principal) {
			h.resource(w, r, principal, scope, reviewer)
		})
	}, auth.Require(httpx.ResourceMethodNotAllowed(h.logger, "GET, HEAD, PUT")))
}

func (h *handler) registerScopedRoutes(mux *http.ServeMux, auth ScopedAuthentication, prompts ScopedPrompts, observe func(ScopeRoute)) {
	fallback := httpx.ResourceMethodNotAllowed(h.logger, "GET, HEAD, PUT")
	h.registerCommonRoutes(mux, observe, func(scope model.PromptScope, reviewer bool) http.HandlerFunc {
		return auth.RequireScoped(func(w http.ResponseWriter, r *http.Request, authorization model.CredentialAuthorization) {
			h.resourceWith(w, r, authorization.Principal, scope,
				func(ctx context.Context, id string) (model.PromptResource, error) {
					if reviewer {
						return prompts.GetReviewerAuthorized(ctx, authorization, scope, id)
					}
					return prompts.GetAuthorized(ctx, authorization, scope, id)
				},
				func(ctx context.Context, id, expected, revision, text string) (model.PromptResource, error) {
					if reviewer {
						return prompts.PutReviewerAuthorized(ctx, authorization, scope, id, expected, revision, text)
					}
					return prompts.PutAuthorized(ctx, authorization, scope, id, expected, revision, text)
				})
		})
	}, auth.RequireScoped(func(w http.ResponseWriter, r *http.Request, authorization model.CredentialAuthorization) {
		fallback(w, r, authorization.Principal)
	}))
}

func (h *handler) registerCommonRoutes(mux *http.ServeMux, observe func(ScopeRoute), resource func(model.PromptScope, bool) http.HandlerFunc, fallback http.HandlerFunc) {
	routes := routeRegistry{mux: mux, observe: observe}
	for _, route := range []struct {
		path     string
		scope    model.PromptScope
		reviewer bool
	}{
		{"/api/v1/me/worker-prompt", model.PromptScopeUser, false},
		{"/api/v1/me/projects/{projectId}/worker-prompt", model.PromptScopeProject, false},
		{"/api/v1/me/workers/{workerId}/prompt", model.PromptScopeWorker, false},
		{"/api/v1/me/reviewer-prompt", model.PromptScopeUser, true},
		{"/api/v1/me/projects/{projectId}/reviewer-prompt", model.PromptScopeProject, true},
		{"/api/v1/me/workers/{workerId}/reviewer-prompt", model.PromptScopeWorker, true},
	} {
		routes.handle("GET "+route.path, resource(route.scope, route.reviewer), routeRead)
		routes.handle("PUT "+route.path, resource(route.scope, route.reviewer), routeWrite)
		routes.handle(route.path, fallback, routeFallback)
	}
}

func (h *handler) resource(w http.ResponseWriter, r *http.Request, principal model.Principal, scope model.PromptScope, reviewer bool) {
	h.resourceWith(w, r, principal, scope,
		func(ctx context.Context, id string) (model.PromptResource, error) {
			if reviewer {
				return h.prompts.GetReviewer(ctx, principal, scope, id)
			}
			return h.prompts.Get(ctx, principal, scope, id)
		},
		func(ctx context.Context, id, expected, revision, text string) (model.PromptResource, error) {
			if reviewer {
				return h.prompts.PutReviewer(ctx, principal, scope, id, expected, revision, text)
			}
			return h.prompts.Put(ctx, principal, scope, id, expected, revision, text)
		})
}

func (h *handler) resourceWith(w http.ResponseWriter, r *http.Request, principal model.Principal, scope model.PromptScope, get func(context.Context, string) (model.PromptResource, error), put func(context.Context, string, string, string, string) (model.PromptResource, error)) {
	logger := h.logger.With("user_id", principal.UserID)
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		httpx.WriteError(w, r, logger, "worker_prompt", "validate", httpx.InvalidInput("worker prompt does not accept query parameters"))
		return
	}
	id := principal.UserID
	var err error
	switch scope {
	case model.PromptScopeProject:
		id, err = model.CanonicalID(r.PathValue("projectId"))
	case model.PromptScopeWorker:
		id, err = model.CanonicalID(r.PathValue("workerId"))
	}
	if err != nil {
		httpx.WriteError(w, r, logger, "worker_prompt", "validate", err)
		return
	}
	var result model.PromptResource
	if r.Method == http.MethodPut {
		fields, decodeErr := decodePut(w, r, h.bodyReadTimeout)
		if decodeErr != nil {
			err = decodeErr
		} else {
			var expected, revision, text string
			expected, err = httpx.RequiredString(fields, "expectedUserId")
			if err == nil {
				var canonical string
				canonical, err = model.CanonicalID(expected)
				if err == nil && canonical != expected {
					err = httpx.InvalidInput("expectedUserId must be a canonical UUID")
				}
			}
			if err == nil {
				revision, err = httpx.RequiredString(fields, "revision")
			}
			if err == nil {
				text, err = httpx.RequiredString(fields, "text")
			}
			if err == nil {
				result, err = put(r.Context(), id, expected, revision, text)
			}
		}
	} else {
		result, err = get(r.Context(), id)
	}
	if err != nil {
		httpx.WriteError(w, r, logger, "worker_prompt", "exchange", err)
		return
	}
	if r.Method == http.MethodHead {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method == http.MethodPut {
		httpx.WriteMutationJSON(w, r, logger, "worker_prompt", http.StatusOK, result)
		return
	}
	httpx.WriteJSON(w, r, logger, http.StatusOK, result)
}

func decodePut(w http.ResponseWriter, r *http.Request, timeout time.Duration) (map[string]json.RawMessage, error) {
	fields, err := httpx.DecodeObjectLimitWithTimeout(w, r, httpx.MaxJSONBody, timeout, "expectedUserId", "revision", "text")
	if err != nil {
		return nil, err
	}
	for _, raw := range fields {
		if !jsonunicode.Valid(raw) {
			return nil, httpx.InvalidInput("request body must be valid Unicode JSON")
		}
	}
	return fields, nil
}
