package preview

import (
	"net"
	"net/http"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/google/uuid"
)

// Wrap reserves the complete preview namespace before the main mux can serve
// APIs or normalize paths. Only the exact bare host and canonical task hosts own routes.
func (h *Routes) Wrap(main http.Handler, taskHandlers ...http.Handler) http.Handler {
	preview := h.Handler()
	var task http.Handler = http.NotFoundHandler()
	if len(taskHandlers) > 0 && taskHandlers[0] != nil {
		task = taskHandlers[0]
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host == h.main.Host {
			main.ServeHTTP(w, r)
			return
		}
		if r.Host == h.preview.Host {
			httpx.CloseUnreadBody(w, r)
			preview.ServeHTTP(w, r)
			return
		}
		if h.taskHost(r.Host) != "" {
			securityHeaders(w)
			w.Header().Set("Origin-Agent-Cluster", "?1")
			if r.Method == http.MethodHead {
				w = headWriter{ResponseWriter: w}
			}
			if isDocument(r) {
				w = &documentWriter{ResponseWriter: w, routes: h, request: r}
			}
			httpx.CloseUnreadBody(w, r)
			task.ServeHTTP(w, r)
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
		httpx.CloseUnreadBody(w, r)
		http.NotFound(w, r)
	})
}

func (h *Routes) taskHost(authority string) string {
	port := ""
	if h.preview.Port() != "" {
		port = ":" + h.preview.Port()
	}
	suffix := "." + h.preview.Hostname() + port
	if !strings.HasSuffix(authority, suffix) {
		return ""
	}
	label := strings.TrimSuffix(authority, suffix)
	id, err := uuid.Parse(label)
	if err != nil || id == uuid.Nil || id.String() != label {
		return ""
	}
	return label
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
