package team

import (
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

const MaxNameCodePoints = 256
const MaxNameBytes = 1024

// AdmitName checks the candidate's size; existing name validity rules remain separate.
func AdmitName(name string) error {
	if n := utf8.RuneCountInString(name); n > MaxNameCodePoints {
		return &limit.Violation{Field: "name", Actual: int64(n), Max: MaxNameCodePoints, Unit: "code points"}
	}
	if n := len(name); n > MaxNameBytes {
		return &limit.Violation{Field: "name", Actual: int64(n), Max: MaxNameBytes, Unit: "bytes"}
	}
	return nil
}
