package tasksteps

import (
	"errors"
	"slices"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

var ErrSelfAnchor = errors.New("step cannot be its own position anchor")

type Placement struct {
	Before   *string
	After    *string
	Position *string
}

// MoveCandidate resolves the target before its anchor and inserts the saved row
// into the remaining collection, so forward moves use final-array positions.
// The caller validates placement syntax and the current dense collection.
func MoveCandidate(current []model.TaskStep, stepID string, placement Placement) ([]model.TaskStep, int, int, error) {
	from := slices.IndexFunc(current, func(step model.TaskStep) bool { return step.ID == stepID })
	if from < 0 {
		return nil, 0, 0, ErrTargetNotFound
	}
	if placement.Before != nil && *placement.Before == stepID || placement.After != nil && *placement.After == stepID {
		return nil, 0, 0, ErrSelfAnchor
	}
	target := current[from]
	remaining := slices.Concat(current[:from], current[from+1:])
	to := 0
	if placement.Position != nil {
		if *placement.Position == "last" {
			to = len(remaining)
		}
	} else {
		to = slices.IndexFunc(remaining, func(step model.TaskStep) bool {
			return placement.Before != nil && step.ID == *placement.Before || placement.After != nil && step.ID == *placement.After
		})
		if to < 0 {
			return nil, 0, 0, ErrAnchorNotFound
		}
		if placement.After != nil {
			to++
		}
	}
	candidate := slices.Insert(remaining, to, target)
	for index := range candidate {
		candidate[index].Position = int64(index)
	}
	return candidate, from, to, nil
}
