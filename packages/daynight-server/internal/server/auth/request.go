package auth

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"

	usage "github.com/codetreker/daynight/packages/daynight-server/internal/core/credentialusage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type AuthenticateCredential func(context.Context, model.CredentialKind, string) (model.Principal, error)
type ObserveUsage func(context.Context, usage.Source, model.CredentialUsageEvent) error
type AuthenticateAPIAccess func(context.Context, string) (store.OAuthAccessIdentity, error)

type RequestAuthentication struct {
	authenticate AuthenticateCredential
	origin       string
	secure       bool
	logger       *slog.Logger
	observeUsage ObserveUsage
	apiAccess    AuthenticateAPIAccess
	apiOrigin    string
}

// BindAPIAccess configures the application verifier for explicit browser channel credentials.
func (h *RequestAuthentication) BindAPIAccess(authenticate AuthenticateAPIAccess, origin string) {
	h.apiAccess, h.apiOrigin = authenticate, origin
}

func (h *RequestAuthentication) AuthenticateAPIAccess(request *http.Request, token string) (store.OAuthAccessIdentity, error) {
	if h.apiAccess == nil {
		return store.OAuthAccessIdentity{}, Failure()
	}
	identity, err := h.apiAccess(request.Context(), token)
	if err != nil {
		return store.OAuthAccessIdentity{}, err
	}
	origins := request.Header.Values("Origin")
	if h.apiOrigin == "" || len(origins) != 1 || origins[0] != h.apiOrigin {
		return store.OAuthAccessIdentity{}, &model.Fault{Code: "forbidden", Message: "Application channels require the configured application Origin."}
	}
	return identity, nil
}

func NewRequestAuthentication(authenticate AuthenticateCredential, settings authconfig.AuthSettings, logger *slog.Logger, observers ...ObserveUsage) (*RequestAuthentication, error) {
	if len(observers) > 1 || len(observers) == 1 && observers[0] == nil {
		return nil, errors.New("invalid credential usage observer")
	}
	origin, err := authconfig.ValidatePublicOrigin(settings)
	if err != nil {
		return nil, err
	}
	h := &RequestAuthentication{authenticate: authenticate, origin: settings.PublicOrigin, secure: origin.Scheme == "https", logger: logger}
	if len(observers) == 1 {
		h.observeUsage = observers[0]
	}
	return h, nil
}

func (h *RequestAuthentication) Origin() string { return h.origin }

func (h *RequestAuthentication) SessionCookieName() string {
	if h.secure {
		return "__Host-daynight_session"
	}
	return "daynight_session"
}

func Failure() error {
	return &model.Fault{Code: "unauthenticated", Message: "Authentication is required. Please log in again."}
}

func requestCookie(request *http.Request, name string) (string, bool) {
	value, count := "", 0
	for _, cookie := range request.Cookies() {
		if cookie.Name == name {
			value, count = cookie.Value, count+1
		}
	}
	return value, count == 1
}

func (h *RequestAuthentication) AuthenticateRequest(request *http.Request) (model.Principal, error) {
	if values, present := request.Header["Authorization"]; present {
		if len(values) != 1 {
			return model.Principal{}, Failure()
		}
		parts := strings.Fields(values[0])
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			return model.Principal{}, Failure()
		}
		principal, err := h.authenticate(request.Context(), model.PATCredential, parts[1])
		if err != nil {
			return principal, err
		}
		if h.observeUsage != nil {
			event := model.CredentialUsageEvent{Kind: model.UsageSubjectPAT, UserID: principal.UserID, SubjectID: principal.CredentialID, At: time.Now().UTC().Truncate(time.Microsecond)}
			_ = h.observeUsage(request.Context(), usage.SourceHTTPPAT, event)
			_ = httpx.PublishCredentialUsageFaults(h.logger, request.Context())
		}
		return principal, nil
	}
	secret, ok := requestCookie(request, h.SessionCookieName())
	if !ok {
		return model.Principal{}, Failure()
	}
	principal, err := h.authenticate(request.Context(), model.SessionCredential, secret)
	if err != nil {
		return model.Principal{}, err
	}
	if request.Method != "GET" && request.Method != "HEAD" && request.Method != "OPTIONS" {
		origins := request.Header.Values("Origin")
		if len(origins) != 1 || origins[0] != h.origin {
			return model.Principal{}, &model.Fault{Code: "forbidden", Message: "Cookie writes require the exact main-site Origin."}
		}
	}
	return principal, nil
}

func (h *RequestAuthentication) Require(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		principal, err := h.AuthenticateRequest(request)
		if err != nil {
			httpx.CloseUnreadBody(w, request)
			httpx.WriteError(w, request, h.logger, "auth", "authenticate", err)
			return
		}
		w.Header().Set("Daynight-User-ID", principal.UserID)
		h.logger.InfoContext(request.Context(), "credential authenticated", "component", "auth", "phase", "authenticate", "user_id", principal.UserID, "credential_id", principal.CredentialID, "request_id", httpx.RequestID(request.Context()))
		next(w, request, principal)
	}
}
