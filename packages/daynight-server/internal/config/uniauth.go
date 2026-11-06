package config

import (
	"errors"
	"net"
	"net/url"
	"strings"
	"unicode/utf8"
)

// The pinned UniAuth SDK exposes no separate validator. Keep this pure check
// aligned with New before resource acquisition; application assembly constructs
// the single client. The parity test detects changes to the pinned contract.
// https://github.com/codetreker/uniauth/blob/0978963813fcefd9d553f6cb9bcc319084c764b3/sdk/go/validation.go
func validateUniAuth(c Config) error {
	var cause error
	u, err := url.Parse(c.UniAuthURL)
	switch {
	case err != nil || !utf8.ValidString(c.UniAuthURL) || u.Hostname() == "" || u.Opaque != "" || u.User != nil || strings.ContainsAny(c.UniAuthURL, "?#") || (u.EscapedPath() != "" && u.EscapedPath() != "/"):
		cause = errors.New("uniauth: BaseURL must be an origin without credentials, query, or fragment")
	case !allowedUniAuthScheme(u, c.AllowLoopbackHTTP):
		cause = errors.New("uniauth: BaseURL requires HTTPS or explicitly enabled loopback HTTP")
	case !validUniAuthValue(c.UniAuthAppID, 128) || strings.Contains(c.UniAuthAppID, ":"):
		cause = errors.New("uniauth: App ID requires 1 to 128 UTF-8 bytes without a colon")
	case !validUniAuthValue(c.UniAuthAppSecret, 512):
		cause = errors.New("uniauth: App Secret requires 1 to 512 UTF-8 bytes")
	}
	if cause != nil {
		return &ConfigurationError{Field: "DAYNIGHT_UNIAUTH_URL / DAYNIGHT_UNIAUTH_APP_ID / DAYNIGHT_UNIAUTH_APP_SECRET", Rule: "must identify a valid UniAuth origin and backend App credentials", Cause: cause}
	}
	return nil
}

func validUniAuthValue(value string, maxBytes int) bool {
	return value != "" && len(value) <= maxBytes && utf8.ValidString(value)
}

func allowedUniAuthScheme(u *url.URL, allowLoopbackHTTP bool) bool {
	if u.Scheme == "https" {
		return true
	}
	if u.Scheme != "http" || !allowLoopbackHTTP {
		return false
	}
	if strings.EqualFold(u.Hostname(), "localhost") {
		return true
	}
	ip := net.ParseIP(u.Hostname())
	return ip != nil && ip.IsLoopback()
}
