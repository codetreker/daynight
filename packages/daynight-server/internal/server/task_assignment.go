package server

import (
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func optionalAssignedTo(fields map[string]json.RawMessage) (**string, error) {
	raw, exists := fields["assignedTo"]
	if !exists {
		return nil, nil
	}
	var value *string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, httpx.InvalidInput("assignedTo must be a UUID or null")
	}
	return &value, nil
}
