package session

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"

	"net/http"
	"strconv"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func (h *Routes) registerTestRoutes(mux *http.ServeMux) {
	routes := map[string]httpx.AuthenticatedHandler{
		"GET /api/v1/test-sessions":                                            h.listTest,
		"GET /api/v1/test-session-capabilities":                                h.testCapabilities,
		"POST /api/v1/test-sessions":                                           h.registerTest,
		"GET /api/v1/test-sessions/{sessionId}":                                h.testSnapshot,
		"POST /api/v1/test-sessions/{sessionId}/controller-grant":              h.grant,
		"POST /api/v1/test-sessions/{sessionId}/stop":                          h.stopTest,
		"GET /api/v1/test-sessions/{sessionId}/timeline":                       h.timeline,
		"POST /api/v1/test-sessions/{sessionId}/commands":                      h.submit,
		"GET /api/v1/test-sessions/{sessionId}/operations/{operationId}":       h.operation,
		"GET /api/v1/test-sessions/{sessionId}/resources/{resourceId}/content": h.resource,
		"GET /api/v1/test-sessions/{sessionId}/channel":                        h.browserChannel,
	}
	for route, handler := range routes {
		mux.HandleFunc(route, h.auth.Require(h.Parameters(handler)))
	}
	for path, method := range map[string]string{"/api/v1/test-session-capabilities": "GET", "/api/v1/test-sessions": "GET, POST", "/api/v1/test-sessions/{sessionId}": "GET", "/api/v1/test-sessions/{sessionId}/controller-grant": "POST", "/api/v1/test-sessions/{sessionId}/stop": "POST", "/api/v1/test-sessions/{sessionId}/timeline": "GET", "/api/v1/test-sessions/{sessionId}/commands": "POST", "/api/v1/test-sessions/{sessionId}/operations/{operationId}": "GET", "/api/v1/test-sessions/{sessionId}/resources/{resourceId}/content": "GET", "/api/v1/test-sessions/{sessionId}/channel": "GET"} {
		fallback := h.auth.Require(func(w http.ResponseWriter, r *http.Request, _ model.Principal) {
			httpx.MethodNotAllowed(h.logger, method)(w, r)
		})
		mux.HandleFunc(path, fallback)
		if method == "GET" || method == "GET, POST" {
			mux.HandleFunc("HEAD "+path, fallback)
		}
	}
}
func (h *Routes) testCapabilities(w http.ResponseWriter, r *http.Request, _ model.Principal) {
	if _, err := httpx.QueryValues(r); err != nil {
		h.Failure(w, r, err)
		return
	}
	httpx.WriteJSON(w, r, h.logger, http.StatusOK, map[string]any{"protocol": sp.Protocol, "schemaVersion": 1, "projectionVersion": 1, "providers": []string{"codex", "claude", "copilot"}})
}
func (h *Routes) registerTest(w http.ResponseWriter, r *http.Request, p model.Principal) {
	body, err := ReadBody(w, r)
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	input, err := sp.DecodeTestRegistration(body)
	if err != nil {
		h.Failure(w, r, httpx.InvalidInput("Invalid test session registration."))
		return
	}
	result, err := h.service.RegisterTest(r.Context(), p, input)
	h.Result(w, r, http.StatusOK, map[string]any{"session": result}, err)
}
func (h *Routes) testSnapshot(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if _, err := httpx.QueryValues(r); err != nil {
		h.Failure(w, r, err)
		return
	}
	result, err := h.service.TestSnapshot(r.Context(), p, r.PathValue("sessionId"))
	h.Result(w, r, http.StatusOK, map[string]any{"session": result}, err)
}
func (h *Routes) stopTest(w http.ResponseWriter, r *http.Request, p model.Principal) {
	body, err := ReadBody(w, r)
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	input, err := sp.DecodeTestStop(body)
	if err != nil {
		h.Failure(w, r, httpx.InvalidInput("Invalid test session stop proof."))
		return
	}
	result, err := h.service.StopTest(r.Context(), p, r.PathValue("sessionId"), input)
	h.Result(w, r, http.StatusOK, map[string]any{"session": result}, err)
}

func (h *Routes) listTest(w http.ResponseWriter, r *http.Request, p model.Principal) {
	values, err := httpx.QueryValues(r, "cursor", "limit", "online")
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	limit := 50
	if values.Has("limit") {
		limit, err = strconv.Atoi(values.Get("limit"))
	}
	if err != nil || limit < 1 || limit > 100 || values.Has("cursor") && values.Get("cursor") == "" || values.Has("online") && values.Get("online") != "true" && values.Get("online") != "false" {
		h.Failure(w, r, httpx.InvalidInput("Invalid test session list cursor, limit or online filter."))
		return
	}
	result, err := h.service.ListTest(r.Context(), p, values.Get("cursor"), limit, values.Get("online") == "true")
	h.Result(w, r, http.StatusOK, result, err)
}
