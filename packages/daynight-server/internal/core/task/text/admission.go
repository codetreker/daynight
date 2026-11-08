// Package text defines the shared size admission policy for Task and Step text.
package text

import (
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

const (
	MaxTitleBytes       = 1024
	MaxDescriptionBytes = 64 * 1024
)

// Admit checks the existing text semantics and the UTF-8 byte budgets. It does
// not change the supplied text or perform I/O.
func Admit(title, description string) error {
	if !utf8.ValidString(title) || strings.ContainsRune(title, 0) || strings.TrimSpace(title) == "" {
		return errors.New("title must contain a non-whitespace character in valid UTF-8 without NUL")
	}
	if !utf8.ValidString(description) || strings.ContainsRune(description, 0) {
		return errors.New("description must be valid UTF-8 without NUL")
	}
	if len(title) > MaxTitleBytes {
		return &limit.Violation{Field: "title", Actual: int64(len(title)), Max: MaxTitleBytes, Unit: "bytes"}
	}
	if len(description) > MaxDescriptionBytes {
		return &limit.Violation{Field: "description", Actual: int64(len(description)), Max: MaxDescriptionBytes, Unit: "bytes"}
	}
	return nil
}
