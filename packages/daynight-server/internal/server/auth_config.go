package server

import (
	"net/url"
	"path"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

func validateAuthSettings(config AuthConfig, callbackURL string) (*url.URL, string, error) {
	origin, err := url.Parse(config.PublicOrigin)
	if err != nil || !utf8.ValidString(config.PublicOrigin) || origin.Host == "" || origin.User != nil || origin.RawQuery != "" || origin.ForceQuery || origin.Fragment != "" || origin.Path != "" || origin.Opaque != "" || config.PublicOrigin != origin.Scheme+"://"+origin.Host {
		return nil, "", &ConfigurationError{Field: "DAYNIGHT_PUBLIC_ORIGIN", Rule: "must be an exact origin without a path, query, or user information"}
	}
	hostname, port := origin.Hostname(), origin.Port()
	if hostname == "" || hostname != strings.ToLower(hostname) || strings.HasSuffix(origin.Host, ":") {
		return nil, "", &ConfigurationError{Field: "DAYNIGHT_PUBLIC_ORIGIN", Rule: "requires a nonempty canonical lower-case host"}
	}
	if port != "" {
		number, parseErr := strconv.Atoi(port)
		if parseErr != nil || number < 1 || number > 65535 || strconv.Itoa(number) != port || origin.Scheme == "https" && number == 443 || origin.Scheme == "http" && number == 80 {
			return nil, "", &ConfigurationError{Field: "DAYNIGHT_PUBLIC_ORIGIN", Rule: "requires a canonical port from 1 to 65535 with the scheme-default port omitted"}
		}
	}
	if origin.Scheme != "https" && (origin.Scheme != "http" || !config.AllowHTTPTestOrigin) {
		return nil, "", &ConfigurationError{Field: "DAYNIGHT_PUBLIC_ORIGIN", Rule: "requires HTTPS or explicit HTTP test-origin configuration"}
	}
	callback, err := url.Parse(callbackURL)
	if err != nil || len(callbackURL) > 2048 || !utf8.ValidString(callbackURL) || callback.User != nil || callback.Opaque != "" || callback.Scheme+"://"+callback.Host != config.PublicOrigin || callback.RawQuery != "" || callback.ForceQuery || strings.Contains(callbackURL, "#") {
		return nil, "", &ConfigurationError{Field: "DAYNIGHT_UNIAUTH_CALLBACK_URL", Rule: "must use the exact main-site origin without credentials, query, or fragment"}
	}
	callbackPath := callback.Path
	if callbackPath == "" || callbackPath == "/" || !strings.HasPrefix(callbackPath, "/") || path.Clean(callbackPath) != callbackPath || callback.RawPath != "" || strings.ContainsAny(callbackPath, "{}%\\") || strings.ContainsFunc(callbackPath, func(char rune) bool { return unicode.IsSpace(char) || unicode.IsControl(char) }) {
		return nil, "", &ConfigurationError{Field: "DAYNIGHT_UNIAUTH_CALLBACK_URL", Rule: "requires a canonical non-root callback path without routing wildcards or encoded aliases"}
	}
	for _, reserved := range []string{"/api/v1/session-capabilities", "/api/v1/test-session-capabilities", "/api/v1/controller-channel", "/api/v1/controller-resources", "/api/v1/projects", "/api/v1/test-sessions", "/test-sessions", "/workers", "/api/v1/me", "/api/v1/invitations", "/api/v1/auth/login", "/api/v1/auth/logout", "/api/v1/auth/providers", "/api/v1/auth/device", "/device", "/healthz", "/readyz", "/assets", "/login", "/projects", "/account", "/invitations", "/setup"} {
		if callbackPath == reserved || strings.HasPrefix(callbackPath, reserved+"/") {
			return nil, "", &ConfigurationError{Field: "DAYNIGHT_UNIAUTH_CALLBACK_URL", Rule: "must not overlap an application API, page, asset, or health route"}
		}
	}
	return origin, callbackPath, nil
}
