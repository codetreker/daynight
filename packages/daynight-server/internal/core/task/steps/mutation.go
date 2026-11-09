package steps

import (
	"errors"
	"math"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/text"
)

// Mutation is an admitted dense candidate and its affected interval.
type Mutation struct {
	Candidate []model.TaskStep
	From, To  int
	Changed   bool
}

func checkCollection(header model.TaskHeader, current []model.TaskStep) error {
	_, err := codec.Collection(header, current)
	return err
}

func ensureVersion(header model.TaskHeader) error {
	if header.Version == math.MaxInt64 {
		return &model.Fault{Code: "version_exhausted", Message: "Task version is exhausted."}
	}
	return nil
}

func missingTarget(header model.TaskHeader, err error) error {
	return NotFound(header.Version, err)
}

func admitText(step model.TaskStep) error {
	if err := text.Admit(step.Title, step.Description); err != nil {
		return &model.Fault{Code: "invalid_input", Message: err.Error(), Cause: err}
	}
	return nil
}

func AdmitAdd(header model.TaskHeader, current []model.TaskStep, step model.TaskStep, before, after *string) (Mutation, error) {
	if err := checkCollection(header, current); err != nil {
		return Mutation{}, err
	}
	candidate, position, err := AddCandidate(current, step, before, after)
	switch {
	case errors.Is(err, ErrIDConflict):
		return Mutation{}, &model.Fault{Code: "step_id_conflict", Message: "Step ID already exists."}
	case errors.Is(err, ErrAnchorNotFound):
		return Mutation{}, &model.Fault{Code: "not_found", Message: "Step anchor was not found."}
	case err != nil:
		return Mutation{}, err
	}
	if err := admitText(candidate[position]); err != nil {
		return Mutation{}, err
	}
	if err := ensureVersion(header); err != nil {
		return Mutation{}, err
	}
	return Mutation{Candidate: candidate, To: position, Changed: true}, nil
}

func AdmitChange(header model.TaskHeader, current []model.TaskStep, id string, changes Changes) (Mutation, error) {
	if err := checkCollection(header, current); err != nil {
		return Mutation{}, err
	}
	candidate, index, changed, err := ChangeCandidate(current, id, changes)
	if errors.Is(err, ErrTargetNotFound) {
		return Mutation{}, missingTarget(header, err)
	}
	if err != nil {
		return Mutation{}, err
	}
	if err := admitText(candidate[index]); err != nil {
		return Mutation{}, err
	}
	if changed {
		if err := ensureVersion(header); err != nil {
			return Mutation{}, err
		}
	}
	return Mutation{Candidate: candidate, To: index, Changed: changed}, nil
}

func AdmitDelete(header model.TaskHeader, current []model.TaskStep, id string) (Mutation, error) {
	if err := checkCollection(header, current); err != nil {
		return Mutation{}, err
	}
	candidate, index, err := DeleteCandidate(current, id)
	if errors.Is(err, ErrTargetNotFound) {
		return Mutation{}, missingTarget(header, err)
	}
	if err != nil {
		return Mutation{}, err
	}
	if err := ensureVersion(header); err != nil {
		return Mutation{}, err
	}
	return Mutation{Candidate: candidate, From: index, Changed: true}, nil
}

func AdmitMove(header model.TaskHeader, current []model.TaskStep, id string, placement Placement) (Mutation, error) {
	if err := checkCollection(header, current); err != nil {
		return Mutation{}, err
	}
	candidate, from, to, err := MoveCandidate(current, id, placement)
	switch {
	case errors.Is(err, ErrTargetNotFound):
		return Mutation{}, missingTarget(header, err)
	case errors.Is(err, ErrAnchorNotFound):
		return Mutation{}, &model.Fault{Code: "not_found", Message: "Step anchor was not found.", Cause: err}
	case errors.Is(err, ErrSelfAnchor):
		return Mutation{}, &model.Fault{Code: "invalid_input", Message: "Step cannot be its own position anchor.", Cause: err}
	case err != nil:
		return Mutation{}, err
	}
	changed := from != to
	if changed {
		if err := ensureVersion(header); err != nil {
			return Mutation{}, err
		}
	}
	return Mutation{Candidate: candidate, From: from, To: to, Changed: changed}, nil
}

// EncodeMutation applies the observed database time only to changed content.
func EncodeMutation(header model.TaskHeader, mutation Mutation, observed time.Time, content string) (codec.StepsResource, []byte, error) {
	if mutation.Changed {
		header.Version++
		switch content {
		case "add":
			mutation.Candidate[mutation.To].CreatedAt = observed
			mutation.Candidate[mutation.To].UpdatedAt = observed
		case "change":
			mutation.Candidate[mutation.To].UpdatedAt = observed
		}
	}
	resource, data, err := codec.EncodeCollection(header, mutation.Candidate)
	if mutation.Changed {
		err = EncodingFault(err)
	}
	return resource, data, err
}
