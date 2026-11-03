package tasksteps

import (
	"slices"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

// DeleteCandidate owns its remaining slice, including an explicit empty slice
// for a last-record deletion. Only the retained suffix positions change.
func DeleteCandidate(current []core.TaskStep, stepID string) ([]core.TaskStep, int, error) {
	index := slices.IndexFunc(current, func(step core.TaskStep) bool { return step.ID == stepID })
	if index < 0 {
		return nil, 0, ErrTargetNotFound
	}
	candidate := make([]core.TaskStep, 0, len(current)-1)
	candidate = append(candidate, current[:index]...)
	candidate = append(candidate, current[index+1:]...)
	for position := index; position < len(candidate); position++ {
		candidate[position].Position = int64(position)
	}
	return candidate, index, nil
}
