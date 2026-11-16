package preview

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"time"
)

func (h *Routes) SessionCookieName() string {
	if h.preview.Scheme == "https" {
		return "__Secure-daynight_preview_session"
	}
	return "daynight_preview_session"
}

func (h *Routes) bindingCookieName(state string) string {
	hash := sha256.Sum256([]byte(state))
	prefix := "daynight_login_"
	if h.preview.Scheme == "https" {
		prefix = "__Host-daynight_login_"
	}
	return prefix + hex.EncodeToString(hash[:16])
}

func (h *Routes) cookie(name, value string, expires time.Time) *http.Cookie {
	return &http.Cookie{Name: name, Value: value, Path: "/", Secure: h.preview.Scheme == "https", HttpOnly: true, SameSite: http.SameSiteLaxMode, Expires: expires}
}

func requestCookie(r *http.Request, name string) (string, bool) {
	value, count := "", 0
	for _, cookie := range r.Cookies() {
		if cookie.Name == name {
			value, count = cookie.Value, count+1
		}
	}
	return value, count == 1
}
