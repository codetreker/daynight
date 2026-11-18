package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
)

// ProjectWebhookReceiptOperations persists an authenticated project's delivery.
type ProjectWebhookReceiptOperations interface {
	Receive(context.Context, string, core.ProjectWebhookIdentity, core.WebhookEvent) (core.ProjectWebhookReceiptResult, error)
}

type projectWebhookHandler struct {
	secrets  store.GitHubProjectWebhookSecretReader
	receiver ProjectWebhookReceiptOperations
	logger   *slog.Logger
	budget   time.Duration
}

// RegisterProjectWebhookRoute registers the independently testable project delivery boundary.
func RegisterProjectWebhookRoute(mux *http.ServeMux, secrets store.GitHubProjectWebhookSecretReader, receiver ProjectWebhookReceiptOperations, logger *slog.Logger) {
	if logger == nil {
		logger = slog.Default()
	}
	h := &projectWebhookHandler{secrets: secrets, receiver: receiver, logger: logger, budget: webhookBudget}
	mux.HandleFunc("POST /api/v1/github/projects/{projectId}/webhook", h.receive)
	mux.HandleFunc("/api/v1/github/projects/{projectId}/webhook", httpx.MethodNotAllowed(logger, "POST"))
}

func (h *projectWebhookHandler) receive(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	ctx, cancel := context.WithTimeout(r.Context(), h.budget)
	defer cancel()
	id, err := model.CanonicalID(r.PathValue("projectId"))
	if err != nil {
		httpx.CloseUnreadBody(w, r)
		h.failure(w, r, http.StatusNotFound, "not_found", "project webhook not found", "identity")
		return
	}
	body, err := httpx.ReadBody(w, r.WithContext(ctx), webhookBodyLimit, h.budget)
	if err != nil {
		var bodyError *httpx.BodyReadError
		if errors.As(err, &bodyError) && bodyError.Status == http.StatusRequestEntityTooLarge {
			httpx.WriteBodyError(w, r, h.logger, "github_webhook", "body", err)
		} else if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.As(err, &bodyError) && bodyError.Status == http.StatusRequestTimeout {
			timeout := &httpx.BodyReadError{Cause: err, Status: http.StatusRequestTimeout, Code: "request_timeout", Message: "request body read timed out"}
			httpx.WriteBodyError(appWebhookTimeoutWriter{w}, r, h.logger, "github_webhook", "body", timeout)
		} else {
			httpx.WriteBodyError(w, r, h.logger, "github_webhook", "body", err)
		}
		return
	}
	snapshot, err := h.secrets.ReadGitHubProjectWebhookSecret(ctx, id)
	if ctx.Err() != nil {
		h.failure(w, r, http.StatusServiceUnavailable, "github_unavailable", "webhook processing unavailable", "authenticate")
		return
	}
	if err != nil {
		if errors.Is(err, model.ErrNotFound) {
			h.failure(w, r, http.StatusNotFound, "not_found", "project webhook not found", "authenticate")
		} else {
			h.logFailure(r, "authenticate", err)
			h.failure(w, r, http.StatusServiceUnavailable, "github_unavailable", "webhook processing unavailable", "authenticate")
		}
		return
	}
	if !service.VerifyWebhookSignature(snapshot.Secret, body, webhookHeader(r, "X-Hub-Signature-256")) {
		h.failure(w, r, http.StatusUnauthorized, "unauthenticated", "invalid webhook signature", "authenticate")
		return
	}
	event, relevant, valid := projectWebhookEvent(webhookHeader(r, "X-GitHub-Event"), webhookHeader(r, "X-GitHub-Delivery"), body)
	if ctx.Err() != nil {
		h.failure(w, r, http.StatusServiceUnavailable, "github_unavailable", "webhook processing unavailable", "parse")
		return
	}
	if !valid {
		h.failure(w, r, http.StatusBadRequest, "invalid_input", "invalid webhook delivery", "parse")
		return
	}
	if !relevant {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	identity := core.ProjectWebhookIdentity{ProjectID: id, Version: snapshot.Version, RepositoryID: snapshot.RepositoryID}
	result, err := h.receiver.Receive(ctx, id, identity, event)
	if err != nil || ctx.Err() != nil {
		if err != nil {
			h.logFailure(r, "receive", err)
		}
		h.failure(w, r, http.StatusServiceUnavailable, "github_unavailable", "webhook processing unavailable", "receive")
		return
	}
	if result != core.ProjectWebhookRejected && result != core.ProjectWebhookReceived && result != core.ProjectWebhookEnqueued {
		h.failure(w, r, http.StatusServiceUnavailable, "github_unavailable", "webhook processing unavailable", "receive")
		return
	}
	attrs := []any{"component", "github_webhook", "phase", "receive", "project_id", id, "event", event.Kind, "request_id", httpx.RequestID(r.Context()), "result", string(result)}
	if httpx.ValidRequestID(event.DeliveryID) {
		attrs = append(attrs, "delivery_id", event.DeliveryID)
	}
	h.logger.InfoContext(r.Context(), "project github webhook processed", attrs...)
	if result == core.ProjectWebhookRejected {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (h *projectWebhookHandler) logFailure(r *http.Request, phase string, err error) {
	h.logger.WarnContext(r.Context(), "project github webhook failed", "component", "github_webhook", "phase", phase, "cause", httpx.ErrorKind(err), "request_id", httpx.RequestID(r.Context()))
}

func (h *projectWebhookHandler) failure(w http.ResponseWriter, r *http.Request, status int, code, message, phase string) {
	h.logger.InfoContext(r.Context(), "project github webhook rejected", "component", "github_webhook", "phase", phase, "result_code", code, "request_id", httpx.RequestID(r.Context()))
	httpx.WriteJSON(w, r, h.logger, status, api.ErrorResponse{Error: api.Error{Code: code, Message: message, RequestID: httpx.RequestID(r.Context())}})
}

func projectWebhookEvent(event, delivery string, body []byte) (core.WebhookEvent, bool, bool) {
	if event == "" {
		return core.WebhookEvent{}, false, false
	}
	if event != "ping" && event != "pull_request" {
		return core.WebhookEvent{}, false, true
	}
	trimmed := bytes.TrimSpace(body)
	if !httpx.ValidRequestID(delivery) || len(trimmed) == 0 || trimmed[0] != '{' || !json.Valid(trimmed) {
		return core.WebhookEvent{}, false, false
	}
	var payload struct {
		Repository struct {
			ID int64 `json:"id"`
		} `json:"repository"`
		Number int64 `json:"number"`
	}
	if json.Unmarshal(trimmed, &payload) != nil || payload.Repository.ID <= 0 || event == "pull_request" && payload.Number <= 0 {
		return core.WebhookEvent{}, false, false
	}
	return core.WebhookEvent{Kind: event, DeliveryID: delivery, RepositoryID: payload.Repository.ID, Number: payload.Number}, true, true
}
