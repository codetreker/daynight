package server

import (
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func optionalRequiredPlatform(fields map[string]json.RawMessage) (**string, error) {
	raw, exists := fields["requiredPlatform"]
	if !exists {
		return nil, nil
	}
	var value *string
	if err := json.Unmarshal(raw, &value); err != nil || value != nil && !model.TaskPlatform(*value).Valid() {
		return nil, invalidInput("requiredPlatform must be windows, linux, macos or null")
	}
	return &value, nil
}

func platformValue(value *string) *model.TaskPlatform {
	if value == nil {
		return nil
	}
	platform := model.TaskPlatform(*value)
	return &platform
}

func platformPatch(value **string) **model.TaskPlatform {
	if value == nil {
		return nil
	}
	platform := platformValue(*value)
	return &platform
}

func platformResponse(value *model.TaskPlatform) *string {
	if value == nil {
		return nil
	}
	platform := string(*value)
	return &platform
}
