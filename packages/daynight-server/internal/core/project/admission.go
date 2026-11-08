package project

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
)

const MaxNameCodePoints = team.MaxNameCodePoints
const MaxNameBytes = team.MaxNameBytes
const MaxRepoURLBytes = 4096

func AdmitName(name string) error { return team.AdmitName(name) }
func AdmitRepoURL(value string) error {
	if len(value) > MaxRepoURLBytes {
		return &limit.Violation{Field: "repoUrl", Actual: int64(len(value)), Max: MaxRepoURLBytes, Unit: "bytes"}
	}
	return nil
}
