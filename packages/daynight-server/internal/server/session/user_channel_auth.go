package session

import (
	"context"
	"net/http"
	"strings"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

const authorizationProtocol = "daynight.authorization."

type userAccessKey struct{}

// The access identity belongs to one handshake; refresh never replaces its expiry or principal.
func userAccess(ctx context.Context) (store.OAuthAccessIdentity, bool) {
	identity, ok := ctx.Value(userAccessKey{}).(store.OAuthAccessIdentity)
	return identity, ok
}

func (h *Routes) requireUserChannel(next httpx.AuthenticatedHandler, test bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		protocols := sessionSubprotocols(r)
		application := false
		for _, protocol := range protocols {
			if strings.HasPrefix(protocol, "daynight.authorization") {
				application = true
			}
		}
		if !application {
			// API channels require the marker path to bind their Origin and expiry.
			for _, value := range r.Header.Values("Authorization") {
				parts := strings.Fields(value)
				if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") && strings.HasPrefix(parts[1], oauth.APIAccessPrefix) {
					w.Header().Set("Cache-Control", "no-store")
					h.Failure(w, r, model.Unauthenticated(nil))
					return
				}
			}
			h.auth.Require(next)(w, r)
			return
		}
		// Strip the entire offered list before selection, library errors, or logging.
		r = r.Clone(r.Context())
		r.Header.Del("Sec-WebSocket-Protocol")
		w.Header().Set("Cache-Control", "no-store")
		protocol, token := "", ""
		valid := len(protocols) == 2
		for _, value := range protocols {
			switch {
			case value == sp.Protocol || value == v2.Protocol && !test:
				valid = valid && protocol == ""
				protocol = value
			case strings.HasPrefix(value, authorizationProtocol):
				valid = valid && token == ""
				token = strings.TrimPrefix(value, authorizationProtocol)
				valid = valid && token != "" && validProtocolToken(token)
			default:
				valid = false
			}
		}
		if _, present := r.Header["Authorization"]; present {
			valid = false
		}
		if !valid || protocol == "" || token == "" {
			h.Failure(w, r, httpx.InvalidInput("Application channels require one Session protocol and one authorization marker."))
			return
		}
		r.Header.Set("Sec-WebSocket-Protocol", protocol)
		if _, err := selectedSessionProtocol(r); err != nil {
			h.Failure(w, r, err)
			return
		}
		identity, err := h.auth.AuthenticateAPIAccess(r, token)
		if err != nil {
			h.Failure(w, r, err)
			return
		}
		r = r.WithContext(context.WithValue(r.Context(), userAccessKey{}, identity))
		w.Header().Set("Daynight-User-ID", identity.Principal.UserID)
		h.logger.InfoContext(r.Context(), "credential authenticated", "component", "auth", "phase", "authenticate", "user_id", identity.Principal.UserID, "credential_id", identity.Principal.CredentialID, "request_id", httpx.RequestID(r.Context()))
		next(w, r, identity.Principal)
	}
}

func validProtocolToken(value string) bool {
	for _, c := range value {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("!#$%&'*+-.^_`|~", c) {
			continue
		}
		return false
	}
	return true
}

func (h *Routes) userChannelOrigin(r *http.Request, p model.Principal) error {
	if _, application := userAccess(r.Context()); application {
		return nil // The application verifier already checked its configured exact Origin.
	}
	return h.origin(r, p.Kind == model.SessionCredential)
}

func (h *Routes) closeUserChannel(ctx context.Context, conn *websocket.Conn, err error) {
	if _, application := userAccess(ctx); !application {
		return
	}
	code, reason := websocket.StatusInternalError, "Session channel failed."
	h.mutex.Lock()
	closing := h.closing
	h.mutex.Unlock()
	if closing {
		code, reason = websocket.StatusGoingAway, "Server is shutting down."
	} else if ctx.Err() == context.DeadlineExceeded {
		code, reason = websocket.StatusPolicyViolation, "unauthenticated"
	} else if fault, ok := httpx.KnownFault(err); ok && (fault.Code == "unauthenticated" || fault.Code == "forbidden") {
		code, reason = websocket.StatusPolicyViolation, fault.Code
	} else if err == nil || ctx.Err() != nil {
		return
	}
	// CloseRead cancellation may have already closed the transport. Library Close
	// retains its own write, peer-wait, and goroutine-drain phases.
	_ = conn.Close(code, reason)
}

func connectionContext(r *http.Request) (context.Context, context.CancelFunc) {
	if identity, application := userAccess(r.Context()); application {
		return context.WithDeadline(r.Context(), identity.ExpiresAt)
	}
	return context.WithCancel(r.Context())
}
