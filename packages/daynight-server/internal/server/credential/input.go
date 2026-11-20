// Package credential provides HTTP input and response helpers for account credentials.
package credential

import (
	"bytes"
	"encoding/json"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
	"github.com/google/uuid"
)

// ExpectedUser binds a write to its authenticated account.
func ExpectedUser(fields map[string]json.RawMessage, principal model.Principal) (string, error) {
	raw := fields["expectedUserId"]
	if len(raw) != 0 && !jsonunicode.Valid(raw) {
		return "", httpx.InvalidInput("expectedUserId must contain valid Unicode")
	}
	value, err := httpx.RequiredString(fields, "expectedUserId")
	if err != nil {
		return "", err
	}
	id, err := uuid.Parse(value)
	if err != nil || id == uuid.Nil || id.String() != value {
		return "", httpx.InvalidInput("expectedUserId must be a canonical user ID")
	}
	if value != principal.UserID {
		return "", &model.Fault{Code: "forbidden", Message: "The current account differs from the expected account."}
	}
	return value, nil
}

// NullableDescription retains null and validates escapes before JSON decoding.
func NullableDescription(fields map[string]json.RawMessage, name string, required bool) (*string, error) {
	raw, present := fields[name]
	if !present {
		if required {
			return nil, httpx.InvalidInput(name + " is required and must be a string or null")
		}
		return nil, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	if !jsonunicode.Valid(raw) {
		return nil, httpx.InvalidInput(name + " must contain valid Unicode")
	}
	var result string
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, httpx.InvalidInput(name + " must be a string or null")
	}
	return &result, nil
}

func NoQuery(r *http.Request) error {
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		return httpx.InvalidInput("Query parameters are not supported.")
	}
	return nil
}

type DescriptionResponse struct {
	ID          string  `json:"id"`
	Description *string `json:"description"`
}

// Fields enforces the account credential request-object and Unicode contract.
func Fields(w http.ResponseWriter, r *http.Request, allowed ...string) (map[string]json.RawMessage, error) {
	if err := NoQuery(r); err != nil {
		return nil, err
	}
	fields, err := httpx.DecodeObject(w, r, allowed...)
	if err != nil {
		return nil, err
	}
	for name, raw := range fields {
		if !jsonunicode.Valid(raw) {
			return nil, httpx.InvalidInput(name + " must contain valid Unicode")
		}
	}
	return fields, nil
}

// TargetID validates an identifier before it can enter diagnostics.
func TargetID(value string) error {
	id, err := uuid.Parse(value)
	if err != nil || id == uuid.Nil || id.String() != value {
		return httpx.InvalidInput("credential ID must be a canonical UUID")
	}
	return nil
}
