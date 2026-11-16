package preview

import (
	"net"
	"net/http"
	"strings"
)

// Wrap reserves the complete preview namespace before the main mux can serve
// APIs or normalize paths. Only the exact bare host currently owns routes.
func (h *Routes) Wrap(main http.Handler) http.Handler {
	preview := h.Handler()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host == h.main.Host {
			main.ServeHTTP(w, r)
			return
		}
		if r.Host == h.preview.Host {
			preview.ServeHTTP(w, r)
			return
		}
		host := authorityHostname(r.Host)
		base := h.preview.Hostname()
		previewAddress := net.ParseIP(base)
		addressAlias := previewAddress != nil && previewAddress.Equal(net.ParseIP(host))
		if host != base && !addressAlias && !strings.HasSuffix(host, "."+base) {
			main.ServeHTTP(w, r)
			return
		}
		securityHeaders(w)
		http.NotFound(w, r)
	})
}

// Namespace classification also recognizes malformed authorities so an invalid
// preview port or bracket cannot route the request through the main mux.
func authorityHostname(authority string) string {
	host := strings.ToLower(authority)
	if strings.HasPrefix(host, "[") {
		if end := strings.IndexByte(host, ']'); end >= 0 {
			return strings.TrimRight(host[1:end], ".")
		}
		host = strings.TrimPrefix(host, "[")
	}
	if net.ParseIP(host) != nil {
		return host
	}
	if index := strings.IndexByte(host, ':'); index >= 0 {
		host = host[:index]
	}
	return strings.TrimRight(strings.Trim(host, "[]"), ".")
}
