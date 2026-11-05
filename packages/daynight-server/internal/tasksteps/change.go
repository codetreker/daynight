package tasksteps

import (
	"errors"
	"slices"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

var ErrTargetNotFound = errors.New("step target was not found")

type Changes struct {
	Title       *string
	Description *string
	Status      *model.TaskStepStatus
}

// ChangeCandidate compares content before assigning timestamps and leaves every
// existing identity, position and time untouched. The caller validates the input
// fields and stored collection before applying this task-local change.
func ChangeCandidate(current []model.TaskStep, stepID string, changes Changes) ([]model.TaskStep, int, bool, error) {
	for index, existing := range current {
		if existing.ID != stepID {
			continue
		}
		target := existing
		if changes.Title != nil {
			target.Title = *changes.Title
		}
		if changes.Description != nil {
			target.Description = *changes.Description
		}
		if changes.Status != nil {
			target.Status = *changes.Status
		}
		changed := target.Title != existing.Title || target.Description != existing.Description || target.Status != existing.Status
		candidate := slices.Clone(current)
		candidate[index] = target
		return candidate, index, changed, nil
	}
	return nil, 0, false, ErrTargetNotFound
}
