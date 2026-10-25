package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func requiredTokenTimestamp(fields map[string]json.RawMessage, key string) (*time.Time, error) {
	raw, present := fields[key]
	if !present {
		return nil, invalidInput(key + " is required and must be a UTC timestamp or null")
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var value string
	if json.Unmarshal(raw, &value) != nil || !strings.HasSuffix(value, "Z") {
		return nil, invalidInput(key + " must be a UTC timestamp or null")
	}
	timestamp, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return nil, invalidInput(key + " must be a UTC timestamp or null")
	}
	return &timestamp, nil
}

func utcTokenExpiry(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	stamp := value.UTC()
	return &stamp
}

func (h *Authentication) updateToken(w http.ResponseWriter, r *http.Request, p core.Principal) {
	fields, err := decodeObject(w, r, "expiresAt", "expectedExpiresAt", "expectedUserId")
	if err != nil {
		writeError(w, r, h.logger, "auth", "update_token", err)
		return
	}
	expiry, err := requiredTokenTimestamp(fields, "expiresAt")
	if err != nil {
		writeError(w, r, h.logger, "auth", "update_token", err)
		return
	}
	expected, err := requiredTokenTimestamp(fields, "expectedExpiresAt")
	if err != nil {
		writeError(w, r, h.logger, "auth", "update_token", err)
		return
	}
	userID, err := requiredString(fields, "expectedUserId")
	if err != nil {
		writeError(w, r, h.logger, "auth", "update_token", err)
		return
	}
	result, err := h.identity.UpdatePATExpiry(r.Context(), p, r.PathValue("tokenId"), service.UpdatePATExpiry{ExpiresAt: expiry, ExpectedExpiresAt: expected, ExpectedUserID: userID})
	if err != nil {
		writeError(w, r, h.logger, "auth", "update_token", err)
		return
	}
	writeJSON(w, r, h.logger, http.StatusOK, tokenResponse(result))
}
