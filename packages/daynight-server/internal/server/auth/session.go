package auth

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// AuthenticateSessionRequest admits browser session credentials only. Navigation
// protocols must not grant a browser session from an Authorization header.
func (h *RequestAuthentication) AuthenticateSessionRequest(request *http.Request) (model.Principal, error) {
	if _, present := request.Header["Authorization"]; present {
		return model.Principal{}, Failure()
	}
	value, ok := requestCookie(request, h.SessionCookieName())
	if !ok {
		return model.Principal{}, Failure()
	}
	if h.browserActivity != nil && h.admitsBrowserActivity(request) {
		return h.browserActivity(request.Context(), value, "")
	}
	return h.authenticate(request.Context(), model.SessionCredential, value)
}
