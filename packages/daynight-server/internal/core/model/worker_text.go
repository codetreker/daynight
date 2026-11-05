package model

import (
	"strings"
	"unicode/utf8"
)

// ValidWorkerText reports whether a worker text value is nonempty UTF-8 without NUL.
func ValidWorkerText(value string) bool {
	return strings.TrimSpace(value) != "" && utf8.ValidString(value) && !strings.ContainsRune(value, 0)
}
