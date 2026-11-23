package migration115

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"slices"
)

func object(data []byte, path string, allowed ...string) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return nil, fmt.Errorf("%s must be one JSON object", path)
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, fmt.Errorf("%s must be valid JSON", path)
		}
		key, ok := token.(string)
		if !ok || !slices.Contains(allowed, key) {
			return nil, fmt.Errorf("%s contains an unknown or read-only field", path)
		}
		if _, exists := fields[key]; exists {
			return nil, fmt.Errorf("%s contains a duplicate field", path)
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, fmt.Errorf("%s must be valid JSON", path)
		}
		fields[key] = value
	}
	if _, err := decoder.Token(); err != nil {
		return nil, fmt.Errorf("%s must be valid JSON", path)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, fmt.Errorf("%s must contain exactly one JSON object", path)
	}
	return fields, nil
}

func stringField(fields map[string]json.RawMessage, key, path string) (string, error) {
	raw, exists := fields[key]
	var value string
	if !exists || isNull(raw) || json.Unmarshal(raw, &value) != nil {
		return "", fmt.Errorf("%s.%s is required and must be a string", path, key)
	}
	return value, nil
}

func isNull(raw []byte) bool { return bytes.Equal(bytes.TrimSpace(raw), []byte("null")) }
