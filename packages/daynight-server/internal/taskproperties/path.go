package taskproperties

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

func findWritableProperty(property string) ([]string, writableProperty, error) {
	segments := strings.Split(property, ".")
	if strings.Contains(property, "/") {
		return nil, writableProperty{}, fmt.Errorf("property must be a dot-separated path")
	}
	definitions := writableProperties
	var definition writableProperty
	for _, segment := range segments {
		if segment == "" {
			return nil, writableProperty{}, fmt.Errorf("property path must contain nonempty segments")
		}
		found := false
		for _, candidate := range definitions {
			if candidate.name == segment {
				definition, found = candidate, true
				break
			}
		}
		if !found {
			return nil, writableProperty{}, fmt.Errorf("property path contains an unknown or read-only field")
		}
		definitions = definition.fields
	}
	return segments, definition, nil
}

func DecodePropertyArgument(property, value string) (core.TaskPropertiesPatch, error) {
	segments, definition, err := findWritableProperty(property)
	if err != nil {
		return core.TaskPropertiesPatch{}, err
	}
	raw := json.RawMessage(value)
	if definition.stringArgument {
		decoded, err := stringValue(raw, "value")
		if err != nil {
			decoded = value
		}
		// Strings always encode as JSON; the definition owns the raw-string input rule.
		raw, _ = json.Marshal(decoded)
	}
	if !json.Valid(raw) {
		return core.TaskPropertiesPatch{}, fmt.Errorf("property value must be valid JSON")
	}
	return decodePropertyPath(segments, raw)
}

func DecodePropertyRemoval(property string) (core.TaskPropertiesPatch, error) {
	segments, definition, err := findWritableProperty(property)
	if err != nil {
		return core.TaskPropertiesPatch{}, err
	}
	if definition.reset == nil {
		return core.TaskPropertiesPatch{}, fmt.Errorf("property path must name a removable value")
	}
	return decodePropertyPath(segments, definition.reset)
}

func decodePropertyPath(segments []string, raw json.RawMessage) (core.TaskPropertiesPatch, error) {
	var patch bytes.Buffer
	for _, segment := range segments {
		// Build the nested document linearly so deeply nested input does not
		// repeatedly copy its entire suffix. String key encoding cannot fail.
		key, _ := json.Marshal(segment)
		patch.WriteByte('{')
		patch.Write(key)
		patch.WriteByte(':')
	}
	patch.Write(raw)
	for range segments {
		patch.WriteByte('}')
	}
	return DecodePatch(patch.Bytes())
}
