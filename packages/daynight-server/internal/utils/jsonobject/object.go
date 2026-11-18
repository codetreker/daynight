package jsonobject

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"slices"
)

// UnknownFieldError identifies a rejected field without including its name in
// the public error message. Callers may provide a specific rejection for a
// retired field while retaining strict object decoding.
type UnknownFieldError struct {
	Path  string
	Field string
}

func (e *UnknownFieldError) Error() string {
	return fmt.Sprintf("%s contains an unknown or read-only field", e.Path)
}

func Decode(data []byte, path string, allowed ...string) (map[string]json.RawMessage, error) {
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
			return nil, &UnknownFieldError{Path: path, Field: key}
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
