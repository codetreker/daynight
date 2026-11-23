// Package s2s exposes trusted-server issuance for the fixed application.
package s2s

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreoauth "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth/tokenresponse"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
)

type Issuer interface {
	Issue(context.Context, model.User) (coreoauth.IssuedFamily, error)
}

type Handler struct {
	issuer  Issuer
	keyHash [sha256.Size]byte
	enabled bool
	logger  *slog.Logger
}

func New(issuer Issuer, sharedKey string, logger *slog.Logger) *Handler {
	return &Handler{issuer: issuer, keyHash: sha256.Sum256([]byte(sharedKey)), enabled: sharedKey != "", logger: logger}
}

func (h *Handler) authorized(r *http.Request) bool {
	values := r.Header.Values("Authorization")
	if len(values) != 1 {
		return false
	}
	scheme, key, found := strings.Cut(values[0], " ")
	if !found || !strings.EqualFold(scheme, "S2S") || key == "" {
		return false
	}
	provided := sha256.Sum256([]byte(key))
	return subtle.ConstantTimeCompare(provided[:], h.keyHash[:]) == 1 && h.enabled
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodPost {
		httpx.CloseUnreadBody(w, r)
		w.Header().Set("Allow", http.MethodPost)
		h.writeError(w, r, http.StatusMethodNotAllowed, "invalid_request", nil)
		return
	}
	if !h.authorized(r) {
		httpx.CloseUnreadBody(w, r)
		h.writeError(w, r, http.StatusUnauthorized, "unauthenticated", nil)
		return
	}
	if _, err := httpx.QueryValues(r); err != nil {
		httpx.CloseUnreadBody(w, r)
		h.writeError(w, r, http.StatusBadRequest, "invalid_input", err)
		return
	}
	fields, err := httpx.DecodeObject(w, r, "externalUserId", "profile")
	if err != nil {
		var bodyError *httpx.BodyReadError
		if errors.As(err, &bodyError) {
			httpx.WriteBodyError(w, r, h.logger, "oauth", "s2s_input", err)
		} else {
			h.writeError(w, r, http.StatusBadRequest, "invalid_input", err)
		}
		return
	}
	raw, err := json.Marshal(fields)
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, "server_error", err)
		return
	}
	input, err := authhttp.DecodeExternalUserInput(raw)
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "invalid_input", err)
		return
	}
	user, err := authhttp.ExternalUser(input)
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "invalid_input", err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	issued, err := h.issuer.Issue(ctx, user)
	if err != nil {
		h.issueError(w, r, err)
		return
	}
	logger := h.logger.With("user_id", issued.Grant.UserID, "grant_id", issued.Grant.ID)
	tokenresponse.Write(w, r, logger, api.OAuthAPITokens{AccessToken: issued.AccessToken, TokenType: "Bearer", ExpiresIn: int64(coreoauth.AccessLifetime / time.Second), AccessExpiresAt: issued.AccessExpiresAt, RefreshToken: issued.RefreshToken, GrantExpiresAt: issued.Grant.ExpiresAt, Scope: issued.Grant.Scope, Resource: issued.Grant.Resource, ClientID: issued.Grant.ClientID, GrantID: issued.Grant.ID, UserID: issued.Grant.UserID})
}

func (h *Handler) issueError(w http.ResponseWriter, r *http.Request, err error) {
	facts := operation.CompletionFacts(err)
	failed, _ := store.DatabaseErrorFacts(err)
	status, code := http.StatusInternalServerError, "server_error"
	switch {
	case facts.CleanupFailed:
	case facts.Outcome == store.TransactionUnknown || errors.Is(err, coreoauth.ErrAuthorizationUnknown):
		status, code = http.StatusServiceUnavailable, "outcome_unknown"
	case failed || facts.Outcome == store.TransactionCommitted || facts.Phase != "" && facts.Phase != "operation":
	default:
		if fault, known := httpx.KnownFault(err); known && fault.Code == "invalid_input" {
			status, code = http.StatusBadRequest, "invalid_input"
		}
	}
	h.writeError(w, r, status, code, err)
}

func (h *Handler) writeError(w http.ResponseWriter, r *http.Request, status int, code string, cause error) {
	if cause != nil {
		httpx.LogFailure(h.logger.With("oauth_error_code", code), r.Context(), "oauth", "s2s", &model.Fault{Code: code, Message: "Application token issuance failed.", Cause: cause})
	}
	httpx.WriteJSON(w, r, h.logger, status, struct {
		Error string `json:"error"`
	}{Error: code})
}
