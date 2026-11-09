package attachment

import "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"

const MaxContentBytes = 5 << 20

// AdmitContentSize checks actual file content bytes, independently of metadata.
func AdmitContentSize(size int64) error {
	if size < 0 {
		min := int64(0)
		return &limit.Violation{Field: "content", Actual: size, Max: MaxContentBytes, Min: &min, Unit: "bytes"}
	}
	if size > MaxContentBytes {
		return &limit.Violation{Field: "content", Actual: size, Max: MaxContentBytes, Unit: "bytes"}
	}
	return nil
}
