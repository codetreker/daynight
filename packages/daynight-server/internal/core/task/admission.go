package task

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/text"
)

const MaxDependencies = 15

// AdmitDependencies bounds the complete dependency set; external dependencies
// are already a subset and do not receive a separate allowance.
func AdmitDependencies(dependencies []string) error {
	if len(dependencies) > MaxDependencies {
		return &limit.Violation{Field: "dependsOn", Actual: int64(len(dependencies)), Max: MaxDependencies, Unit: "items"}
	}
	return nil
}

// AdmitCandidate checks the size policies on a candidate. Existing candidate
// construction and graph validation remain responsible for structural rules.
// Properties must already have been normalized with taskproperty.Normalize.
func AdmitCandidate(candidate store.TaskWrite) error {
	if err := text.Admit(candidate.Title, candidate.Description); err != nil {
		return err
	}
	if err := AdmitDependencies(candidate.DependsOn); err != nil {
		return err
	}
	return taskproperty.Admit(candidate.Properties)
}
