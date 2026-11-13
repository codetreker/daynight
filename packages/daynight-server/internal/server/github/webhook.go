package github

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

const webhookBodyLimit = 25 * 1024 * 1024
const webhookBudget = 8 * time.Second

type WebhookOperations interface {
	Receive(context.Context, core.WebhookEvent) error
}

type webhookHandler struct {
	operations WebhookOperations
	secret     []byte
	logger     *slog.Logger
}

// RegisterWebhookRoute mounts the GitHub App signature endpoint independently of user authentication.
func RegisterWebhookRoute(mux *http.ServeMux, operations WebhookOperations, secret string, logger *slog.Logger) {
	h := &webhookHandler{operations: operations, secret: []byte(secret), logger: logger}
	mux.HandleFunc("POST /api/v1/github/webhook", h.receive)
	mux.HandleFunc("/api/v1/github/webhook", httpx.MethodNotAllowed(logger, "POST"))
}

func webhookHeader(r *http.Request, name string) string {
	values := r.Header.Values(name)
	if len(values) != 1 {
		return ""
	}
	return strings.TrimSpace(values[0])
}

func validWebhookSignature(secret, body []byte, header string) bool {
	if !strings.HasPrefix(header, "sha256=") || len(header) != len("sha256=")+sha256.Size*2 {
		return false
	}
	signature, err := hex.DecodeString(header[len("sha256="):])
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(body)
	return hmac.Equal(signature, mac.Sum(nil))
}

type webhookPayload struct {
	Installation struct {
		ID int64 `json:"id"`
	} `json:"installation"`
}

type webhookPRPayload struct {
	webhookPayload
	Repository struct {
		ID int64 `json:"id"`
	} `json:"repository"`
	Number int64 `json:"number"`
}

func webhookEvent(event, delivery string, body []byte) (core.WebhookEvent, bool, bool) {
	var input core.WebhookEvent
	trimmed := bytes.TrimSpace(body)
	if event == "" || len(trimmed) == 0 || trimmed[0] != '{' || !json.Valid(trimmed) {
		return input, false, false
	}
	kind := ""
	switch event {
	case "pull_request":
		kind = "pull_request"
	case "installation", "installation_repositories", "repository":
		kind = "access"
	default:
		return input, false, true
	}
	var payload webhookPayload
	if delivery == "" || json.Unmarshal(trimmed, &payload) != nil || payload.Installation.ID < 1 {
		return input, false, false
	}
	input = core.WebhookEvent{Kind: kind, DeliveryID: delivery, InstallationID: payload.Installation.ID}
	if kind == "pull_request" {
		var pr webhookPRPayload
		if json.Unmarshal(trimmed, &pr) != nil || pr.Repository.ID < 1 || pr.Number < 1 {
			return core.WebhookEvent{}, false, false
		}
		input.RepositoryID, input.Number = pr.Repository.ID, pr.Number
	}
	return input, true, true
}

func (h *webhookHandler) receive(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	ctx, cancel := context.WithTimeout(r.Context(), webhookBudget)
	defer cancel()
	bounded := r.WithContext(ctx)
	delivery := webhookHeader(r, "X-GitHub-Delivery")
	logger := h.logger.With("delivery_id", delivery)
	body, err := httpx.ReadBody(w, bounded, webhookBodyLimit, webhookBudget)
	if err != nil {
		httpx.WriteBodyError(w, r, logger, "github_sync", "receive", err)
		return
	}
	if !validWebhookSignature(h.secret, body, webhookHeader(r, "X-Hub-Signature-256")) {
		h.writeFailure(w, r, logger, http.StatusUnauthorized, "unauthenticated", "invalid webhook signature")
		return
	}
	input, relevant, valid := webhookEvent(webhookHeader(r, "X-GitHub-Event"), delivery, body)
	if !valid {
		h.writeFailure(w, r, logger, http.StatusBadRequest, "invalid_input", "invalid webhook delivery")
		return
	}
	if ctx.Err() != nil {
		h.writeFailure(w, r, logger, http.StatusServiceUnavailable, "github_unavailable", "webhook processing unavailable")
		return
	}
	if !relevant {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err := h.operations.Receive(ctx, input); err != nil || ctx.Err() != nil {
		if err != nil {
			httpx.LogFailure(logger, r.Context(), "github_sync", "receive", err)
		}
		h.writeFailure(w, r, logger, http.StatusServiceUnavailable, "github_unavailable", "webhook processing unavailable")
		return
	}
	logger.InfoContext(r.Context(), "github webhook received", "component", "github_sync", "phase", "receive", "request_id", httpx.RequestID(r.Context()))
	w.WriteHeader(http.StatusAccepted)
}

func (h *webhookHandler) writeFailure(w http.ResponseWriter, r *http.Request, logger *slog.Logger, status int, code, message string) {
	logger.InfoContext(r.Context(), "github webhook rejected", "component", "github_sync", "phase", "receive", "result_code", code, "request_id", httpx.RequestID(r.Context()))
	httpx.WriteJSON(w, r, logger, status, api.ErrorResponse{Error: api.Error{Code: code, Message: message, RequestID: httpx.RequestID(r.Context())}})
}
