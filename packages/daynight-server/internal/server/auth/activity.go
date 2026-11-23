package auth

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	credentialhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/credential"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/google/uuid"
)

const BrowserCookieLifetime = 400 * 24 * time.Hour

type AuthenticateBrowserActivity func(context.Context, string, string) (model.Principal, error)

// BindBrowserActivity equips explicit browser authentication entries with rolling
// activity. Internal credential rechecks continue using the read-only verifier.
func (h *RequestAuthentication) BindBrowserActivity(activity AuthenticateBrowserActivity) {
	if activity == nil {
		panic("browser activity verifier is required")
	}
	h.browserActivity = activity
}

func (h *RequestAuthentication) admitsBrowserActivity(r *http.Request) bool {
	if httpx.IsMethodRejection(r) {
		return false
	}
	method, pattern, qualified := strings.Cut(r.Pattern, " ")
	if !qualified || !(method == r.Method || method == http.MethodGet && r.Method == http.MethodHead) || method == http.MethodHead || method == http.MethodOptions {
		return false
	}
	if !strings.HasPrefix(pattern, "/api/") || strings.HasPrefix(pattern, "/api/v1/auth/") && pattern != "/api/v1/auth/device/inspect" && pattern != "/api/v1/auth/device/decision" {
		return false
	}
	return h.sameOriginActivity(r)
}

func (h *RequestAuthentication) sameOriginActivity(r *http.Request) bool {
	if r.Host != h.authority {
		return false
	}
	origin, present, valid := activityHeader(r, "Origin")
	if !valid || present && origin != h.origin {
		return false
	}
	site, hasSite, validSite := activityHeader(r, "Sec-Fetch-Site")
	mode, hasMode, validMode := activityHeader(r, "Sec-Fetch-Mode")
	dest, hasDest, validDest := activityHeader(r, "Sec-Fetch-Dest")
	user, hasUser, validUser := activityHeader(r, "Sec-Fetch-User")
	if !validSite || !validMode || !validDest || !validUser {
		return false
	}
	if !hasSite && !hasMode && !hasDest && !hasUser {
		return present
	}
	if !hasSite || site != "same-origin" || !hasMode || !hasDest {
		return false
	}
	switch mode {
	case "cors", "same-origin", "no-cors":
		if hasUser {
			return false
		}
		switch dest {
		case "audio", "audioworklet", "empty", "font", "image", "json", "manifest", "paintworklet", "report", "script", "serviceworker", "sharedworker", "style", "text", "track", "video", "webidentity", "worker", "xslt":
			return true
		}
		return false
	case "websocket":
		return dest == "empty" && !hasUser && present
	case "navigate":
		return r.Method == http.MethodGet && (dest == "document" || dest == "embed" || dest == "frame" || dest == "iframe" || dest == "object") && (!hasUser || user == "?1")
	default:
		return false
	}
}

func activityHeader(r *http.Request, name string) (string, bool, bool) {
	values, present := r.Header[http.CanonicalHeaderKey(name)]
	if !present {
		return "", false, true
	}
	if len(values) != 1 || values[0] == "" {
		return "", true, false
	}
	return values[0], true, true
}

func (h *Authentication) sessionActivity(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	for name := range r.Header {
		if strings.EqualFold(name, "Authorization") {
			httpx.CloseUnreadBody(w, r)
			httpx.WriteError(w, r, h.logger, "auth", "activity", &model.Fault{Code: "forbidden", Message: "A main-site browser session is required."})
			return
		}
	}
	origins := r.Header.Values("Origin")
	if len(origins) != 1 || origins[0] != h.origin || !h.sameOriginActivity(r) {
		httpx.CloseUnreadBody(w, r)
		httpx.WriteError(w, r, h.logger, "auth", "activity", &model.Fault{Code: "forbidden", Message: "Browser activity requires the exact main-site Origin."})
		return
	}
	value, present := requestCookie(r, h.SessionCookieName())
	if !present {
		httpx.CloseUnreadBody(w, r)
		httpx.WriteError(w, r, h.logger, "auth", "activity", Failure())
		return
	}
	fields, err := credentialhttp.Fields(w, r, "expectedUserId")
	var expected string
	if err == nil {
		expected, err = httpx.RequiredString(fields, "expectedUserId")
	}
	if err == nil {
		id, parseErr := uuid.Parse(expected)
		if parseErr != nil || id == uuid.Nil || id.String() != expected {
			err = httpx.InvalidInput("expectedUserId must be a canonical user ID")
		}
	}
	if err != nil {
		httpx.WriteError(w, r, h.logger, "auth", "activity", err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	principal, err := h.identity.AuthenticateBrowserActivity(ctx, value, expected)
	if err != nil {
		httpx.WriteError(w, r, h.logger, "auth", "activity", err)
		return
	}
	w.Header().Set("Daynight-User-ID", principal.UserID)
	w.WriteHeader(http.StatusNoContent)
}
