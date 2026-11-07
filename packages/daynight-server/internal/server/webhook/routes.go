// Package webhook implements the private webhook management HTTP adapter.
package webhook

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

type Authenticator interface {
	Require(httpx.AuthenticatedHandler) http.HandlerFunc
}

type Routes struct {
	service Service
	auth    Authenticator
	logger  *slog.Logger
}

// NewRoutes composes the management handlers without starting a runner or
// installing them in the application's mux.
func NewRoutes(service *webhookservice.Service, auth *authhttp.Authentication, logger *slog.Logger) *Routes {
	return &Routes{service: Adapter{Service: service}, auth: auth, logger: logger}
}

// RegisterRoutes attaches the personal and team management resources to mux.
// Calling it is separate from application route registration.
func (h *Routes) RegisterRoutes(mux *http.ServeMux) {
	auth, logger := h.auth, h.logger
	mux.HandleFunc("GET /api/v1/webhook-event-types", auth.Require(h.catalog))
	mux.HandleFunc("/api/v1/webhook-event-types", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
	for _, base := range []string{"/api/v1/me/webhooks", "/api/v1/teams/{teamId}/webhooks"} {
		mux.HandleFunc("GET "+base, auth.Require(h.list))
		mux.HandleFunc("POST "+base, auth.Require(h.create))
		mux.HandleFunc(base, auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, POST")))
		mux.HandleFunc(base+"/{endpointId}", auth.Require(h.endpoint))
		mux.HandleFunc(base+"/{endpointId}/{subresource}", auth.Require(h.subresource))
		mux.HandleFunc("POST "+base+"/{endpointId}/signing-secret/rotations", auth.Require(h.rotate))
		mux.HandleFunc(base+"/{endpointId}/signing-secret/rotations", auth.Require(httpx.ResourceMethodNotAllowed(logger, "POST")))
	}
}

func owner(r *http.Request, p model.Principal) (Owner, error) {
	if id := r.PathValue("teamId"); id != "" {
		id, err := uuidInput(id)
		return Owner{Kind: "team", ID: id}, err
	}
	id, err := uuidInput(p.UserID)
	return Owner{Kind: "personal", ID: id}, err
}

func noQuery(r *http.Request) error {
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		return httpx.InvalidInput("query parameters are not accepted")
	}
	return nil
}

func (h *Routes) failure(w http.ResponseWriter, r *http.Request, p model.Principal, phase string, err error) {
	logger := h.logger.With("user_id", p.UserID)
	var bodyError *httpx.BodyReadError
	if errors.As(err, &bodyError) {
		if bodyError.Status == http.StatusRequestEntityTooLarge {
			copy := *bodyError
			copy.Code = "content_too_large"
			copy.Message = "Request body exceeds 256 KiB."
			err = &copy
			// Closing an oversized unread request can cancel its context before
			// the rejection is written. Keep the 413 response bounded and retain
			// the request metadata while the connection is being closed.
			ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), time.Second)
			defer cancel()
			_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(time.Second))
			r = r.WithContext(ctx)
		}
		httpx.WriteBodyError(w, r, logger, "webhook", phase, err)
		return
	}
	var uriError *httpx.URITooLongError
	if errors.As(err, &uriError) {
		httpx.WriteError(w, r, logger, "webhook", phase, err)
		return
	}
	httpx.CloseUnreadBody(w, r)
	// Only public error codes cross this boundary. Neither database diagnostics
	// nor a domain error message may disclose a destination or signing secret.
	statuses := map[string]int{
		"invalid_input": 400, "invalid_cursor": 400, "invalid_operation_time": 400,
		"unauthenticated": 401, "forbidden": 403, "permission_denied": 403, "not_found": 404,
		"identity_mismatch": 409, "version_conflict": 409, "operation_conflict": 409,
		"version_exhausted": 409, "destination_unsupported": 409,
		"operation_expired": 410, "content_too_large": 413,
		"webhooks_unavailable": 503, "dependency_unavailable": 503,
		"write_outcome_unknown": 503,
	}
	var f *model.Fault
	if known, ok := httpx.KnownFault(err); ok {
		f = known
	} else if errors.As(err, &f) {
		direct := f
		f = nil
		// Explicit unknown-commit faults carry their underlying transaction
		// failure. Other public refusals must not hide a database or cleanup
		// failure behind a domain error.
		failed, _ := store.DatabaseErrorFacts(err)
		facts := operation.CompletionFacts(err)
		if direct.Code == "write_outcome_unknown" || (!failed && !facts.CleanupFailed && (facts.Outcome == "" || facts.Outcome == store.TransactionNotCommitted) && (facts.Phase == "" || facts.Phase == "operation")) {
			f = direct
		}
	}
	status, code := http.StatusInternalServerError, "internal_error"
	if failed, _ := store.DatabaseErrorFacts(err); failed && f == nil {
		status, code = http.StatusServiceUnavailable, "dependency_unavailable"
	}
	if f != nil {
		if selected, ok := statuses[f.Code]; ok {
			status, code = selected, f.Code
		}
	}
	logger.ErrorContext(r.Context(), "webhook request failed", "component", "webhook", "phase", phase, "error_code", code, "request_id", httpx.RequestID(r.Context()))
	if r.Context().Err() != nil {
		return
	}
	httpx.WriteJSON(w, r, logger, status, api.ErrorResponse{Error: api.Error{Code: code, Message: http.StatusText(status), RequestID: httpx.RequestID(r.Context())}})
}

func (h *Routes) catalog(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if err := noQuery(r); err != nil {
		h.failure(w, r, p, "catalog", err)
		return
	}
	value, err := h.service.Catalog(r.Context(), p)
	if err != nil {
		h.failure(w, r, p, "catalog", err)
		return
	}
	httpx.WriteJSON(w, r, h.logger, http.StatusOK, value)
}

func (h *Routes) list(w http.ResponseWriter, r *http.Request, p model.Principal) {
	o, err := owner(r, p)
	var q ListQuery
	if err == nil {
		q, err = listInput(r)
	}
	var value any
	if err == nil {
		value, err = h.service.List(r.Context(), p, o, q)
	}
	if err != nil {
		h.failure(w, r, p, "list", err)
		return
	}
	httpx.WriteJSON(w, r, h.logger, http.StatusOK, value)
}
func (h *Routes) subresource(w http.ResponseWriter, r *http.Request, p model.Principal) {
	kind := ""
	if r.PathValue("endpointId") == "operations" {
		kind = "operation"
		r.SetPathValue("operationId", r.PathValue("subresource"))
	} else if r.PathValue("subresource") == "signing-secret" {
		kind = "secret"
	} else {
		h.failure(w, r, p, "read", &model.Fault{Code: "not_found", Message: "Resource not found."})
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		httpx.ResourceMethodNotAllowed(h.logger, "GET, HEAD")(w, r, p)
		return
	}
	h.read(w, r, p, kind)
}
func (h *Routes) read(w http.ResponseWriter, r *http.Request, p model.Principal, kind string) {
	o, err := owner(r, p)
	if err == nil {
		err = noQuery(r)
	}
	var id string
	if err == nil {
		field := "endpointId"
		if kind == "operation" {
			field = "operationId"
		}
		id, err = uuidInput(r.PathValue(field))
	}
	var value any
	if err == nil {
		switch kind {
		case "operation":
			value, err = h.service.Operation(r.Context(), p, o, id)
		case "secret":
			value, err = h.service.Secret(r.Context(), p, o, id)
		default:
			value, err = h.service.Get(r.Context(), p, o, id)
		}
	}
	if err != nil {
		h.failure(w, r, p, kind, err)
		return
	}
	httpx.WriteJSON(w, r, h.logger, http.StatusOK, value)
}
func (h *Routes) endpoint(w http.ResponseWriter, r *http.Request, p model.Principal) {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		h.read(w, r, p, "get")
	case http.MethodPatch:
		h.write(w, r, p, "endpoint.update")
	case http.MethodDelete:
		h.write(w, r, p, "endpoint.delete")
	default:
		httpx.ResourceMethodNotAllowed(h.logger, "GET, HEAD, PATCH, DELETE")(w, r, p)
	}
}
func (h *Routes) create(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.write(w, r, p, "endpoint.create")
}
func (h *Routes) rotate(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.write(w, r, p, "signing.rotate")
}
func (h *Routes) write(w http.ResponseWriter, r *http.Request, p model.Principal, kind string) {
	o, err := owner(r, p)
	if err == nil {
		err = noQuery(r)
	}
	var id string
	if err == nil && kind != "endpoint.create" {
		id, err = uuidInput(r.PathValue("endpointId"))
	}
	allowed := []string{"operationId", "issuedAt", "expectedUserId"}
	if kind != "endpoint.create" {
		allowed = append(allowed, "ifVersion")
	}
	if kind == "endpoint.create" || kind == "endpoint.update" {
		allowed = append(allowed, "name", "enabled", "destination", "subscriptions")
		if kind == "endpoint.update" {
			allowed = append(allowed, "confirmProjectIds")
		}
	}
	if kind == "signing.rotate" {
		allowed = append(allowed, "mode")
	}
	var mutation Mutation
	if err == nil {
		var fields map[string]json.RawMessage
		var digest string
		fields, digest, err = readBody(w, r, allowed...)
		if err == nil {
			mutation, err = mutationInput(fields, digest, kind, id, p)
		}
	}
	var result MutationResult
	if err == nil {
		result, err = h.service.Mutate(r.Context(), p, o, mutation)
	}
	if err != nil {
		h.failure(w, r, p, kind, err)
		return
	}
	status := http.StatusOK
	if kind == "endpoint.create" && !result.Replay {
		status = http.StatusCreated
	}
	httpx.WriteMutationJSON(w, r, h.logger, "webhook", status, result.Body)
}
