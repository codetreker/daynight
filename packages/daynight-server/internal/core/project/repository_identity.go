package project

import (
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

// RepositoryIdentity follows the CLI repository identity rules. Path bytes are
// retained verbatim: decoding or cleaning them can merge distinct repositories.
func RepositoryIdentity(input string) (string, error) {
	invalid := func() (string, error) {
		return "", invalidInput("Repository address must be a valid HTTPS, SSH, or SCP address.")
	}
	if input == "" || !utf8.ValidString(input) || strings.ContainsFunc(input, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) || strings.ContainsAny(input, "?#") {
		return invalid()
	}
	decoded, err := url.PathUnescape(input)
	if err != nil || !utf8.ValidString(decoded) || strings.ContainsFunc(decoded, unicode.IsControl) {
		return invalid()
	}
	if strings.Contains(input, "://") {
		return repositoryURLIdentity(input)
	}
	return repositorySCPIdentity(input)
}

func repositoryPathIdentity(path string) string {
	trimmed := strings.TrimRight(path, "/")
	withoutSuffix := strings.TrimSuffix(trimmed, ".git")
	if strings.Trim(withoutSuffix, "/") == "" {
		return trimmed
	}
	return withoutSuffix
}

func ordinaryRepositoryPath(path string) bool {
	if strings.HasPrefix(path, "~") {
		return false
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

func repositoryHostIdentity(host string, bracketed bool) (string, error) {
	if addr, err := netip.ParseAddr(host); err == nil && addr.Zone() == "" {
		if addr.Is6() {
			return "[" + addr.String() + "]", nil
		}
		return addr.String(), nil
	}
	if bracketed || !validHost(host) {
		return "", invalidInput("Repository host is invalid.")
	}
	return cases.Lower(language.Und).String(host), nil
}

func repositoryURLIdentity(input string) (string, error) {
	invalid := func() (string, error) {
		return "", invalidInput("Repository address must be a valid HTTPS or SSH address.")
	}
	scheme, rest, ok := strings.Cut(input, "://")
	scheme = strings.ToLower(scheme)
	if !ok || (scheme != "https" && scheme != "ssh") {
		return invalid()
	}
	index := strings.IndexByte(rest, '/')
	if index < 0 {
		return invalid()
	}
	authority, rawPath := rest[:index], rest[index:]
	decodedPath, err := url.PathUnescape(rawPath)
	if err != nil || strings.Trim(decodedPath, "/") == "" {
		return invalid()
	}
	user := ""
	hasUser := false
	if at := strings.LastIndexByte(authority, '@'); at >= 0 {
		hasUser = true
		user, authority = authority[:at], authority[at+1:]
		if scheme == "https" || user == "" || strings.ContainsRune(user, ':') {
			return invalid()
		}
		for _, r := range user {
			if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("-._~!$&'()*+,;=%@", r)) {
				return invalid()
			}
		}
	}
	rawHost, portText := authority, ""
	hasPort, bracketed := false, false
	if strings.HasPrefix(authority, "[") {
		bracketed = true
		end := strings.IndexByte(authority, ']')
		if end < 0 {
			return invalid()
		}
		rawHost = authority[1:end]
		suffix := authority[end+1:]
		if suffix != "" {
			if !strings.HasPrefix(suffix, ":") {
				return invalid()
			}
			hasPort, portText = true, suffix[1:]
		}
	} else if colon := strings.LastIndexByte(authority, ':'); colon >= 0 {
		rawHost, hasPort, portText = authority[:colon], true, authority[colon+1:]
		if scheme == "https" && strings.Contains(rawHost, ":") {
			return invalid()
		}
	}
	// The CLI permits encoded Unicode host text, but not ASCII host escapes.
	for i := 0; i < len(rawHost); i++ {
		if rawHost[i] == '%' && i+2 < len(rawHost) && !strings.EqualFold(rawHost[i:i+3], "%25") {
			n, err := strconv.ParseUint(rawHost[i+1:i+3], 16, 8)
			if err == nil && n < 128 {
				return invalid()
			}
		}
	}
	host, err := url.PathUnescape(rawHost)
	if err != nil {
		return invalid()
	}
	if bracketed {
		addr, err := netip.ParseAddr(host)
		if err != nil || !addr.Is6() || addr.Zone() != "" {
			return invalid()
		}
	}
	host, err = repositoryHostIdentity(host, bracketed)
	if err != nil {
		return "", err
	}
	port := ""
	if hasPort {
		if portText == "" || strings.ContainsFunc(portText, func(r rune) bool { return r < '0' || r > '9' }) {
			return invalid()
		}
		n, err := strconv.ParseUint(portText, 10, 16)
		if err != nil || n == 0 {
			return invalid()
		}
		if !(scheme == "https" && n == 443 || scheme == "ssh" && n == 22) {
			port = ":" + strconv.FormatUint(n, 10)
		}
	}
	path := repositoryPathIdentity(rawPath)
	if port == "" && (scheme == "https" || hasUser && user == "git") && ordinaryRepositoryPath(path[1:]) {
		return host + path, nil
	}
	prefix := ""
	if hasUser {
		prefix = user + "@"
	}
	return scheme + "://" + prefix + host + port + path, nil
}

func repositorySCPIdentity(input string) (string, error) {
	invalid := func() (string, error) { return "", invalidInput("Repository address must be a valid SCP address.") }
	delimiter := strings.IndexByte(input, ':')
	if opening := strings.IndexByte(input, '['); opening >= 0 && opening < delimiter {
		end := strings.Index(input, "]:")
		if end < 0 {
			return invalid()
		}
		delimiter = end + 1
	}
	if delimiter < 0 {
		return invalid()
	}
	authority, rawPath := input[:delimiter], input[delimiter+1:]
	if strings.Trim(rawPath, "/") == "" {
		return invalid()
	}
	user, host, hasUser := strings.Cut(authority, "@")
	if hasUser {
		if user == "" || strings.ContainsAny(user, ":/[]") {
			return invalid()
		}
	} else {
		host = authority
		component, _, _ := strings.Cut(rawPath, "/")
		if at := strings.IndexByte(component, '@'); at >= 0 && strings.Contains(component[at+1:], ":") {
			return invalid()
		}
	}
	bracketed := strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]")
	if bracketed {
		host = host[1 : len(host)-1]
	}
	host, err := repositoryHostIdentity(host, bracketed)
	if err != nil {
		return "", err
	}
	path := repositoryPathIdentity(rawPath)
	if hasUser && user == "git" && ordinaryRepositoryPath(path) {
		return host + "/" + path, nil
	}
	prefix := ""
	if hasUser {
		prefix = user + "@"
	}
	return "scp://" + prefix + host + ":" + path, nil
}
