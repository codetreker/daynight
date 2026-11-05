package steps

import (
	"errors"
	"slices"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

var ErrIDConflict = errors.New("step ID already exists")
var ErrAnchorNotFound = errors.New("step anchor was not found")

// AddCandidate leaves current rows untouched and resolves identity before placement.
// Time assignment and encoding belong to the locked write after version admission.
func AddCandidate(current []model.TaskStep, step model.TaskStep, before, after *string) ([]model.TaskStep, int, error) {
	for _, existing := range current {
		if existing.ID == step.ID {
			return nil, 0, ErrIDConflict
		}
	}
	position := len(current)
	if before != nil || after != nil {
		position = -1
		for index, existing := range current {
			if before != nil && existing.ID == *before {
				position = index
			}
			if after != nil && existing.ID == *after {
				position = index + 1
			}
		}
		if position == -1 {
			return nil, 0, ErrAnchorNotFound
		}
	}
	candidate := slices.Insert(slices.Clone(current), position, step)
	for index := range candidate {
		candidate[index].Position = int64(index)
	}
	return candidate, position, nil
}
