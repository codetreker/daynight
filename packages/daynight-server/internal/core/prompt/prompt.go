package prompt

import (
	"math"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func invalid() error { return &model.Fault{Code: "invalid_input", Message: "Prompt input is invalid."} }

// Revision accepts only the canonical decimal representation of an int64.
func Revision(value string) (int64, error) {
	if value == "" || len(value) > 19 || (len(value) > 1 && value[0] == '0') {
		return 0, invalid()
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return 0, invalid()
		}
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, invalid()
	}
	return n, nil
}

func ValidateText(text string) error {
	if !utf8.ValidString(text) || len(text) > 1024*1024 || strings.ContainsFunc(text, func(r rune) bool { return (r < 0x20 && r != '\t' && r != '\n' && r != '\r') || r >= 0x7f && r <= 0x9f }) {
		return invalid()
	}
	return nil
}

func Next(current model.PromptResource, expected int64, text string) (int64, bool, error) {
	actual, err := Revision(current.Revision)
	if err != nil {
		return 0, false, err
	}
	if actual != expected {
		return 0, false, &model.Fault{Code: "version_conflict", Message: "The prompt revision has changed."}
	}
	if current.Text == text {
		return actual, false, nil
	}
	if actual == math.MaxInt64 {
		return 0, false, &model.Fault{Code: "version_exhausted", Message: "The prompt revision is exhausted."}
	}
	return actual + 1, true, nil
}
