package github

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
)

// AppWebhookOperations authenticates raw deliveries and records verified hints.
// Authentication returns only the identity and credential version needed to
// recheck the same App in the signal transaction.
type AppWebhookOperations interface {
	AuthenticateAppWebhook(context.Context, string, []byte, string) (service.AppWebhookIdentity, error)
	ReceiveAppWebhook(context.Context, service.AppWebhookIdentity, core.WebhookEvent) error
}

type appWebhookHandler struct {
	operations AppWebhookOperations
	logger     *slog.Logger
	budget     time.Duration
	parse      func(context.Context, string, string, []byte) (core.WebhookEvent, bool, bool)
}

// RegisterAppWebhookRoute installs the App-aware boundary without user authentication.
// Its adoption in the public server is controlled by the App integration.
func RegisterAppWebhookRoute(mux *http.ServeMux, operations AppWebhookOperations, logger *slog.Logger) {
	if logger == nil {
		logger = slog.Default()
	}
	h := &appWebhookHandler{operations: operations, logger: logger, budget: webhookBudget, parse: appWebhookEvent}
	mux.HandleFunc("POST /api/v1/github/apps/{localAppId}/webhook", h.receive)
	mux.HandleFunc("/api/v1/github/apps/{localAppId}/webhook", httpx.MethodNotAllowed(logger, "POST"))
}

func (h *appWebhookHandler) receive(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	ctx, cancel := context.WithTimeout(r.Context(), h.budget)
	defer cancel()
	id, err := model.CanonicalID(r.PathValue("localAppId"))
	if err != nil {
		h.failure(w, r, http.StatusNotFound, "not_found", "App not found")
		return
	}
	body, err := httpx.ReadBody(w, r.WithContext(ctx), webhookBodyLimit, h.budget)
	if err != nil {
		var bodyError *httpx.BodyReadError
		if errors.As(err, &bodyError) && bodyError.Status == http.StatusRequestEntityTooLarge {
			httpx.WriteBodyError(w, r, h.logger, "github_webhook", "receive", err)
		} else if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.As(err, &bodyError) && bodyError.Status == http.StatusRequestTimeout {
			timeout := &httpx.BodyReadError{Cause: err, Status: http.StatusRequestTimeout, Code: "request_timeout", Message: "request body read timed out"}
			httpx.WriteBodyError(appWebhookTimeoutWriter{w}, r, h.logger, "github_webhook", "receive", timeout)
		} else {
			httpx.WriteBodyError(w, r, h.logger, "github_webhook", "receive", err)
		}
		return
	}
	identity, err := h.operations.AuthenticateAppWebhook(ctx, id, body, webhookHeader(r, "X-Hub-Signature-256"))
	if ctx.Err() != nil {
		h.failure(w, r, http.StatusServiceUnavailable, "github_unavailable", "webhook processing unavailable")
		return
	}
	if err != nil {
		switch {
		case errors.Is(err, model.ErrNotFound):
			h.failure(w, r, http.StatusNotFound, "not_found", "App not found")
		case errors.Is(err, service.ErrAppWebhookUnauthenticated):
			h.failure(w, r, http.StatusUnauthorized, "unauthenticated", "invalid webhook signature")
		default:
			httpx.LogFailure(h.logger, r.Context(), "github_webhook", "authenticate", err)
			h.failure(w, r, http.StatusServiceUnavailable, "github_unavailable", "webhook processing unavailable")
		}
		return
	}
	input, relevant, valid := h.parse(ctx, webhookHeader(r, "X-GitHub-Event"), webhookHeader(r, "X-GitHub-Delivery"), body)
	if ctx.Err() != nil {
		h.failure(w, r, http.StatusServiceUnavailable, "github_unavailable", "webhook processing unavailable")
		return
	}
	if !valid {
		h.failure(w, r, http.StatusBadRequest, "invalid_input", "invalid webhook delivery")
		return
	}
	if !relevant {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err := h.operations.ReceiveAppWebhook(ctx, identity, input); err != nil || ctx.Err() != nil {
		if err != nil {
			httpx.LogFailure(h.logger, r.Context(), "github_webhook", "receive", err)
		}
		h.failure(w, r, http.StatusServiceUnavailable, "github_unavailable", "webhook processing unavailable")
		return
	}
	h.logger.InfoContext(r.Context(), "github webhook received", "component", "github_webhook", "phase", "receive", "app_resource_id", id, "event", webhookHeader(r, "X-GitHub-Event"), "delivery_id", input.DeliveryID, "request_id", httpx.RequestID(r.Context()))
	w.WriteHeader(http.StatusAccepted)
}

func (h *appWebhookHandler) failure(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	h.logger.InfoContext(r.Context(), "github webhook rejected", "component", "github_webhook", "phase", "receive", "result_code", code, "request_id", httpx.RequestID(r.Context()))
	httpx.WriteJSON(w, r, h.logger, status, api.ErrorResponse{Error: api.Error{Code: code, Message: message, RequestID: httpx.RequestID(r.Context())}})
}

// Timeout rejection may need the body helper's detached write when a socket
// read cancels the request. The App contract reports that deadline as 503.
type appWebhookTimeoutWriter struct{ http.ResponseWriter }

func (w appWebhookTimeoutWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w appWebhookTimeoutWriter) WriteHeader(status int) {
	if status == http.StatusRequestTimeout {
		status = http.StatusServiceUnavailable
	}
	w.ResponseWriter.WriteHeader(status)
}

// Unknown event types do not require a GitHub payload schema, but a missing or
// ambiguous event header cannot identify an event as irrelevant.
func appWebhookEvent(_ context.Context, event, delivery string, body []byte) (core.WebhookEvent, bool, bool) {
	switch event {
	case "":
		return core.WebhookEvent{}, false, false
	case "pull_request", "installation", "installation_repositories", "repository":
		return webhookEvent(event, delivery, body)
	default:
		return core.WebhookEvent{}, false, true
	}
}
