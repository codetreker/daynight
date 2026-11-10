package project

import (
	"net"
	"net/url"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func validateRepoURLSize(value string) error {
	if err := AdmitRepoURL(value); err != nil {
		return &model.Fault{Code: "invalid_input", Message: err.Error(), Cause: err}
	}
	return nil
}

func validateRepoURL(value string) error {
	if err := validateRepoURLSize(value); err != nil {
		return err
	}
	invalid := func() error { return invalidInput("Repository address must be a valid HTTPS, SSH, or SCP address.") }
	if value == "" || !utf8.ValidString(value) || strings.ContainsFunc(value, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) {
		return invalid()
	}
	decoded, err := url.PathUnescape(value)
	if err != nil || !utf8.ValidString(decoded) || strings.ContainsFunc(decoded, unicode.IsControl) {
		return invalid()
	}
	if !strings.Contains(value, "://") {
		if !validSCPAddress(value) {
			return invalid()
		}
		return nil
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Opaque != "" || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" ||
		strings.ContainsAny(value, "?#") || !validHost(parsed.Hostname()) || strings.Trim(parsed.Path, "/") == "" ||
		(strings.HasPrefix(parsed.Host, "[") && net.ParseIP(parsed.Hostname()) == nil) {
		return invalid()
	}
	if parsed.Port() != "" {
		port, err := strconv.ParseUint(parsed.Port(), 10, 16)
		if err != nil || port == 0 {
			return invalid()
		}
	} else if strings.HasSuffix(parsed.Host, ":") {
		return invalid()
	}
	switch strings.ToLower(parsed.Scheme) {
	case "https":
		if parsed.User != nil {
			return invalid()
		}
	case "ssh":
		if parsed.User != nil {
			_, hasPassword := parsed.User.Password()
			if parsed.User.Username() == "" || hasPassword {
				return invalid()
			}
		}
	default:
		return invalid()
	}
	return nil
}

func validSCPAddress(value string) bool {
	if strings.ContainsAny(value, "?#") {
		return false
	}
	delimiter := strings.IndexByte(value, ':')
	if opening := strings.IndexByte(value, '['); opening >= 0 && opening < delimiter {
		end := strings.Index(value, "]:")
		if end < 0 {
			return false
		}
		delimiter = end + 1
	}
	if delimiter < 0 {
		return false
	}
	authority, path := value[:delimiter], value[delimiter+1:]
	user, host, hasUser := strings.Cut(authority, "@")
	if hasUser {
		if user == "" || strings.ContainsAny(user, ":/[]") {
			return false
		}
	} else {
		host = authority
		component, _, _ := strings.Cut(path, "/")
		if at := strings.IndexByte(component, '@'); at >= 0 && strings.Contains(component[at+1:], ":") {
			return false
		}
	}
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		return net.ParseIP(host[1:len(host)-1]) != nil && strings.Trim(path, "/") != ""
	}
	return validHost(host) && strings.Trim(path, "/") != ""
}

func validHost(host string) bool {
	if host == "" {
		return false
	}
	if net.ParseIP(host) != nil {
		return true
	}
	for _, r := range host {
		if !unicode.IsLetter(r) && !unicode.IsNumber(r) && !strings.ContainsRune("-._~!$&'()*+,;=", r) {
			return false
		}
	}
	return true
}
