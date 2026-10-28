package server

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"net/http"
	"strconv"
)

func (h *sessionRoutes) registerTestRoutes(mux *http.ServeMux) {
	routes := map[string]AuthenticatedHandler{
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
		mux.HandleFunc(route, h.auth.Require(h.parameters(handler)))
	}
	for path, method := range map[string]string{"/api/v1/test-session-capabilities": "GET", "/api/v1/test-sessions": "GET, POST", "/api/v1/test-sessions/{sessionId}": "GET", "/api/v1/test-sessions/{sessionId}/controller-grant": "POST", "/api/v1/test-sessions/{sessionId}/stop": "POST", "/api/v1/test-sessions/{sessionId}/timeline": "GET", "/api/v1/test-sessions/{sessionId}/commands": "POST", "/api/v1/test-sessions/{sessionId}/operations/{operationId}": "GET", "/api/v1/test-sessions/{sessionId}/resources/{resourceId}/content": "GET", "/api/v1/test-sessions/{sessionId}/channel": "GET"} {
		fallback := h.auth.Require(func(w http.ResponseWriter, r *http.Request, _ core.Principal) {
			methodNotAllowed(h.logger, method)(w, r)
		})
		mux.HandleFunc(path, fallback)
		if method == "GET" || method == "GET, POST" {
			mux.HandleFunc("HEAD "+path, fallback)
		}
	}
}
func (h *sessionRoutes) testCapabilities(w http.ResponseWriter, r *http.Request, _ core.Principal) {
	if _, err := queryValues(r); err != nil {
		h.failure(w, r, err)
		return
	}
	writeJSON(w, r, h.logger, http.StatusOK, map[string]any{"protocol": sp.Protocol, "schemaVersion": 1, "projectionVersion": 1, "providers": []string{"codex", "claude", "copilot"}})
}
func (h *sessionRoutes) registerTest(w http.ResponseWriter, r *http.Request, p core.Principal) {
	body, err := relayBody(w, r)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	input, err := sp.DecodeTestRegistration(body)
	if err != nil {
		h.failure(w, r, invalidInput("Invalid test session registration."))
		return
	}
	result, err := h.service.RegisterTest(r.Context(), p, input)
	h.result(w, r, http.StatusOK, map[string]any{"session": result}, err)
}
func (h *sessionRoutes) testSnapshot(w http.ResponseWriter, r *http.Request, p core.Principal) {
	if _, err := queryValues(r); err != nil {
		h.failure(w, r, err)
		return
	}
	result, err := h.service.TestSnapshot(r.Context(), p, r.PathValue("sessionId"))
	h.result(w, r, http.StatusOK, map[string]any{"session": result}, err)
}
func (h *sessionRoutes) stopTest(w http.ResponseWriter, r *http.Request, p core.Principal) {
	body, err := relayBody(w, r)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	input, err := sp.DecodeTestStop(body)
	if err != nil {
		h.failure(w, r, invalidInput("Invalid test session stop proof."))
		return
	}
	result, err := h.service.StopTest(r.Context(), p, r.PathValue("sessionId"), input)
	h.result(w, r, http.StatusOK, map[string]any{"session": result}, err)
}

func (h *sessionRoutes) listTest(w http.ResponseWriter, r *http.Request, p core.Principal) {
	values, err := queryValues(r, "cursor", "limit", "online")
	if err != nil {
		h.failure(w, r, err)
		return
	}
	limit := 50
	if values.Has("limit") {
		limit, err = strconv.Atoi(values.Get("limit"))
	}
	if err != nil || limit < 1 || limit > 100 || values.Has("cursor") && values.Get("cursor") == "" || values.Has("online") && values.Get("online") != "true" && values.Get("online") != "false" {
		h.failure(w, r, invalidInput("Invalid test session list cursor, limit or online filter."))
		return
	}
	result, err := h.service.ListTest(r.Context(), p, values.Get("cursor"), limit, values.Get("online") == "true")
	h.result(w, r, http.StatusOK, result, err)
}
