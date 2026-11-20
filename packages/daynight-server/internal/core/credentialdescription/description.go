// Package credentialdescription owns the shared account credential description rules.
package credentialdescription

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"
)

var ErrInvalid = errors.New("invalid credential description")

// Normalize returns nil for a cleared description and a normalized value otherwise.
func Normalize(value *string) (*string, error) {
	if value == nil {
		return nil, nil
	}
	if !utf8.ValidString(*value) {
		return nil, ErrInvalid
	}
	for _, r := range *value {
		switch r {
		case 0, '\n', '\r', '\v', '\f', '\u0085', '\u2028', '\u2029':
			return nil, ErrInvalid
		}
	}
	trimmed := strings.TrimFunc(*value, unicode.IsSpace)
	if trimmed == "" {
		return nil, nil
	}
	if utf8.RuneCountInString(trimmed) > 100 {
		return nil, ErrInvalid
	}
	return &trimmed, nil
}

// ValidateExpected accepts only values already returned by the service.
func ValidateExpected(value *string) error {
	if value == nil {
		return nil
	}
	normalized, err := Normalize(value)
	if err != nil || normalized == nil || *normalized != *value {
		return ErrInvalid
	}
	return nil
}
