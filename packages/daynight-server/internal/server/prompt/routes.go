// Package prompt adapts personal Worker prompt resources to HTTP.
package prompt

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

type prompts interface {
	Get(context.Context, model.Principal, model.PromptScope, string) (model.PromptResource, error)
	Put(context.Context, model.Principal, model.PromptScope, string, string, string, string) (model.PromptResource, error)
}

type handler struct {
	prompts prompts
	logger  *slog.Logger
}

type authenticator interface {
	Require(httpx.AuthenticatedHandler) http.HandlerFunc
}

// RegisterRoutes exposes the three account-owned prompt resources.
func RegisterRoutes(mux *http.ServeMux, prompts prompts, auth authenticator, logger *slog.Logger) {
	h := &handler{prompts: prompts, logger: logger}
	for _, route := range []struct {
		path  string
		scope model.PromptScope
	}{
		{"/api/v1/me/worker-prompt", model.PromptScopeUser},
		{"/api/v1/me/projects/{projectId}/worker-prompt", model.PromptScopeProject},
		{"/api/v1/me/workers/{workerId}/prompt", model.PromptScopeWorker},
	} {
		scope := route.scope
		resource := func(w http.ResponseWriter, r *http.Request, principal model.Principal) {
			h.resource(w, r, principal, scope)
		}
		mux.HandleFunc("GET "+route.path, auth.Require(resource))
		mux.HandleFunc("PUT "+route.path, auth.Require(resource))
		mux.HandleFunc(route.path, auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, PUT")))
	}
}

func (h *handler) resource(w http.ResponseWriter, r *http.Request, principal model.Principal, scope model.PromptScope) {
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
		fields, decodeErr := decodePut(w, r)
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
				result, err = h.prompts.Put(r.Context(), principal, scope, id, expected, revision, text)
			}
		}
	} else {
		result, err = h.prompts.Get(r.Context(), principal, scope, id)
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

func decodePut(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, error) {
	fields, err := httpx.DecodeObject(w, r, "expectedUserId", "revision", "text")
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
