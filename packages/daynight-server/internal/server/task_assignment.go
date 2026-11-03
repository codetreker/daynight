package server

import "encoding/json"

func optionalAssignedTo(fields map[string]json.RawMessage) (**string, error) {
	raw, exists := fields["assignedTo"]
	if !exists {
		return nil, nil
	}
	var value *string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, invalidInput("assignedTo must be a UUID or null")
	}
	return &value, nil
}
