package auth

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func (h *Authentication) writeCachedUser(w http.ResponseWriter, request *http.Request, user api.User) {
	body, err := json.Marshal(user)
	if err != nil {
		httpx.WriteError(w, request, h.logger, "auth", "me", err)
		return
	}
	if request.Context().Err() != nil {
		return
	}
	body = append(body, '\n')
	digest := sha256.Sum256(body)
	etag := `"` + hex.EncodeToString(digest[:]) + `"`
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("ETag", etag)
	w.Header().Set("Content-Type", "application/json")
	// Each reuse is authenticated before the principal-bearing representation is validated.
	if matchesEntityTag(request.Header.Values("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	if request.Method == http.MethodHead {
		return
	}
	if _, err := w.Write(body); err != nil {
		httpx.LogFailure(h.logger, request.Context(), "auth", "response", err)
	}
}

// If-None-Match uses weak comparison even for a strong representation validator:
// https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2
func matchesEntityTag(values []string, current string) bool {
	value := strings.TrimSpace(strings.Join(values, ","))
	if value == "*" {
		return true
	}
	matched := false
	for value != "" {
		value = strings.TrimLeft(value, " \t,")
		if value == "" {
			break
		}
		value = strings.TrimPrefix(value, "W/")
		if value == "" || value[0] != '"' {
			return false
		}
		end := 1
		for end < len(value) && value[end] != '"' {
			if value[end] < 0x21 || value[end] == 0x7f {
				return false
			}
			end++
		}
		if end == len(value) {
			return false
		}
		matched = matched || value[:end+1] == current
		value = strings.TrimLeft(value[end+1:], " \t")
		if value != "" && value[0] != ',' {
			return false
		}
	}
	return matched
}
