package bot

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
)

// MaxCwdBytes is shared with the Worker working-directory limit.
const MaxCwdBytes = worker.MaxWorkingDirectoryBytes

// AdmitCwd checks the byte budget independently of the existing path rules.
func AdmitCwd(value string) error {
	if len(value) > MaxCwdBytes {
		return &limit.Violation{Field: "cwd", Actual: int64(len(value)), Max: MaxCwdBytes, Unit: "bytes"}
	}
	return nil
}
