package mcp

import (
	_ "embed"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

//go:embed installation.md
var installationTemplate string

func renderInstallationManual(resource string) string {
	jsonURL, _ := json.Marshal(resource)
	shellURL := "'" + strings.ReplaceAll(resource, "'", "'\"'\"'") + "'"
	return strings.NewReplacer(
		"{{MCP_URL}}", resource,
		"{{MCP_SHELL_URL}}", shellURL,
		"{{MCP_JSON_URL}}", string(jsonURL),
	).Replace(installationTemplate)
}

func isInstallationRequest(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	for _, header := range []string{"MCP-Protocol-Version", "MCP-Session-Id", "MCP-Method", "MCP-Name", "Last-Event-ID"} {
		if len(r.Header.Values(header)) != 0 {
			return false
		}
	}
	// Streamable HTTP clients explicitly list text/event-stream. Wildcards are
	// also sent by browsers and curl, so they must leave the manual discoverable.
	for _, value := range r.Header.Values("Accept") {
		for _, part := range strings.Split(value, ",") {
			mediaType, _, _ := strings.Cut(part, ";")
			if strings.EqualFold(strings.TrimSpace(mediaType), "text/event-stream") {
				return false
			}
		}
	}
	return true
}

func (e *Entry) serveInstallationManual(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(e.manual)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write([]byte(e.manual))
	}
}
