package cors

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

const requestHeaders = "Authorization, Content-Type, Accept, If-None-Match, X-Request-ID, Daynight-Worker-Protocol, Daynight-Worker-Configuration, Daynight-Worker-Control-Mode, Daynight-Worker-Tool-Paths, Daynight-Bot-Attention, Daynight-Worker-Prompts, Daynight-Session-Protocol, X-Daynight-Startup-Version, Daynight-Browser-Client, Daynight-Session-Content-Revision, Daynight-Chunk-SHA256"
const exposedHeaders = "Daynight-User-ID, Daynight-Task-Epoch, X-Request-ID, Location, ETag, Content-Disposition, Retry-After, Allow, WWW-Authenticate, Daynight-Worker-Control-Mode, Daynight-Worker-Tool-Paths, Daynight-Bot-Attention, Daynight-Worker-Configuration, Daynight-Session-Direct-Upload-Version"

// Wrap decorates user REST responses before authentication and path validation.
// Route lookup never runs a handler or authenticates a preflight request.
func Wrap(next http.Handler, mux *http.ServeMux, origin string, logger *slog.Logger, nativePaths ...string) http.Handler {
	if origin == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method := r.Method
		if method == http.MethodOptions {
			method = r.Header.Get("Access-Control-Request-Method")
		}
		probe := r.Clone(r.Context())
		probe.Method = method
		_, pattern := mux.Handler(probe)
		if !userREST(r.URL.Path, nativePaths) {
			next.ServeHTTP(w, r)
			return
		}
		if producerRoute(method, pattern) {
			if r.Method == http.MethodOptions {
				httpx.CloseUnreadBody(w, r)
				httpx.WriteError(w, r, logger, "cors", "preflight", &model.Fault{Code: "forbidden", Message: "Producer operations are not available to browser API clients."})
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		vary(w.Header(), "Origin")
		if r.Method == http.MethodOptions {
			vary(w.Header(), "Access-Control-Request-Method", "Access-Control-Request-Headers")
		}
		origins := r.Header.Values("Origin")
		if len(origins) != 1 || origins[0] != origin {
			if r.Method == http.MethodOptions {
				httpx.CloseUnreadBody(w, r)
				httpx.WriteError(w, r, logger, "cors", "preflight", &model.Fault{Code: "forbidden", Message: "Browser API preflight requires the configured exact Origin."})
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Expose-Headers", exposedHeaders)
		if r.Method != http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		methods := r.Header.Values("Access-Control-Request-Method")
		if len(methods) != 1 || !registeredMethod(method, pattern) || !allowedHeaders(r.Header.Values("Access-Control-Request-Headers")) {
			httpx.CloseUnreadBody(w, r)
			httpx.WriteError(w, r, logger, "cors", "preflight", &model.Fault{Code: "forbidden", Message: "The requested method or headers are not available to browser API clients."})
			return
		}
		w.Header().Set("Access-Control-Allow-Methods", method)
		w.Header().Set("Access-Control-Allow-Headers", requestHeaders)
		httpx.CloseUnreadBody(w, r)
		w.WriteHeader(http.StatusNoContent)
	})
}

func userREST(path string, nativePaths []string) bool {
	if !strings.HasPrefix(path, "/api/v1/") && !strings.HasPrefix(path, "/api/v2/") {
		return false
	}
	// Public OAuth and native login retain their independent browser policies.
	for _, native := range append([]string{"/api/v1/auth/login", "/api/v1/auth/providers", "/api/v1/auth/device/code", "/api/v1/auth/device/token", "/api/v1/controller-channel"}, nativePaths...) {
		if path == native {
			return false
		}
	}
	for _, prefix := range []string{"/api/v1/oauth/requests/", "/api/v1/oauth/s2s/", "/api/v1/controller-resources/"} {
		if strings.HasPrefix(path, prefix) {
			return false
		}
	}
	return true
}

func producerRoute(method, pattern string) bool {
	for _, suffix := range []string{"/worker-channel", "/worker-messages", "/image-history-ledger/{fileId}", "/image-history-ledger/{fileId}/status"} {
		if strings.HasSuffix(pattern, suffix) {
			return true
		}
	}
	_, path, typed := strings.Cut(pattern, " ")
	if !typed {
		path = pattern
	}
	index := strings.LastIndex(path, "/archive")
	if index < 0 || !strings.HasSuffix(path[:index], "/sessions/{sessionId}") && !strings.HasSuffix(path[:index], "/test-sessions/{sessionId}") {
		return false
	}
	// Archive preparation and writer receipts use upload admission even for
	// GET. User archive bytes use read admission and remain browser-readable.
	switch path[index:] {
	case "/archive":
		return method == "POST" || method == "PUT"
	case "/archive/prepare":
		return method == "GET" || method == "HEAD" || method == "POST"
	case "/archive/source-tail", "/archive/seal":
		return method == "POST"
	case "/archive/content", "/archive/prepare/history/{fileId}", "/archive/files/{fileId}":
		return method == "PUT"
	case "/archive/prepare/history/{fileId}/status", "/archive/files/{fileId}/status":
		return method == "GET" || method == "HEAD"
	}
	return false
}

func registeredMethod(method, pattern string) bool {
	if method != "GET" && method != "HEAD" && method != "POST" && method != "PUT" && method != "PATCH" && method != "DELETE" {
		return false
	}
	registered, path, typed := strings.Cut(pattern, " ")
	if typed {
		// These registrations reserve literal paths against wildcard resources;
		// their handlers refuse every method except POST.
		if path == "/api/v1/projects/{projectId}/tasks/search" {
			return method == http.MethodPost && registered == http.MethodPost
		}
		if method == http.MethodHead {
			// Explicit HEAD handlers are refusals. Terminal-only reads also
			// refuse HEAD after protocol selection inside the Session adapter.
			return registered == http.MethodGet && path != "/api/v1/projects/{projectId}/tasks/{taskId}/sessions" && !strings.HasSuffix(path, "/sessions/{sessionId}/state")
		}
		return registered == method
	}
	// Legacy methodless resource dispatchers own these methods inside their
	// adapters. Methodless fallbacks elsewhere are never accepted.
	if pattern == "/api/v1/me/bots/{botId}" {
		return method == "GET" || method == "HEAD" || method == "DELETE"
	}
	if pattern == "/api/v1/bots/{id}/attention/seen" {
		return method == http.MethodPost
	}
	for _, base := range []string{"/api/v1/me/webhooks", "/api/v1/teams/{teamId}/webhooks"} {
		suffix, ok := strings.CutPrefix(pattern, base)
		if !ok {
			continue
		}
		switch suffix {
		case "/{endpointId}":
			return method == "GET" || method == "HEAD" || method == "PATCH" || method == "DELETE"
		case "/{endpointId}/{subresource}", "/{endpointId}/deliveries", "/{endpointId}/deliveries/{deliveryId}", "/{endpointId}/deliveries/{deliveryId}/attempts", "/{endpointId}/deliveries/{deliveryId}/payload":
			return method == "GET" || method == "HEAD"
		case "/{endpointId}/deliveries/{deliveryId}/redeliveries":
			return method == "POST"
		}
	}
	return false
}

func allowedHeaders(values []string) bool {
	for _, value := range values {
		for name := range strings.SplitSeq(value, ",") {
			name = strings.TrimSpace(name)
			found := false
			for allowed := range strings.SplitSeq(requestHeaders, ", ") {
				if strings.EqualFold(name, allowed) {
					found = true
					break
				}
			}
			if !found {
				return false
			}
		}
	}
	return true
}

func vary(header http.Header, names ...string) {
	for _, name := range names {
		found := false
		for _, value := range header.Values("Vary") {
			for token := range strings.SplitSeq(value, ",") {
				if strings.EqualFold(strings.TrimSpace(token), name) || strings.TrimSpace(token) == "*" {
					found = true
				}
			}
		}
		if !found {
			header.Add("Vary", name)
		}
	}
}
