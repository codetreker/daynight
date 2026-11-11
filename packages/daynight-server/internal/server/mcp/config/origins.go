package config

import (
	"errors"
	"net/url"
	"strings"
)

// ValidateOrigins accepts exact browser origins without paths or credentials.
func ValidateOrigins(origins []string) error {
	for _, origin := range origins {
		u, err := url.Parse(origin)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" || u.String() != origin || u.Hostname() == "" || u.Hostname() != strings.ToLower(u.Hostname()) {
			return errors.New("invalid MCP allowed origin")
		}
	}
	return nil
}
