package steps

import (
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
)

func invalidInput(message string) error {
	return &model.Fault{Code: "invalid_input", Message: message}
}

// CanonicalID validates the task-local step identity.
func CanonicalID(id string) (string, error) {
	id, err := codec.CanonicalID(id)
	if err != nil {
		return "", invalidInput(err.Error())
	}
	return id, nil
}

// NotFound identifies absence after a parent was admitted.
func NotFound(version int64, cause error) error {
	return &model.Fault{Code: "not_found", Message: "Step was not found.", Cause: &StepAbsence{Version: version, Cause: cause}}
}

// PrepareAdd validates and canonicalizes the input before taking write locks.
func PrepareAdd(id, title, description string, status *model.TaskStepStatus, before, after *string) (model.TaskStep, *string, *string, error) {
	id, err := codec.CanonicalID(id)
	if err != nil {
		return model.TaskStep{}, nil, nil, invalidInput(err.Error())
	}
	if err := codec.ValidateText(title, description); err != nil {
		return model.TaskStep{}, nil, nil, invalidInput(err.Error())
	}
	value := model.TaskStepTodo
	if status != nil {
		value = *status
	}
	if !value.Valid() {
		return model.TaskStep{}, nil, nil, invalidInput("Step status must be todo, in_progress, done or skipped.")
	}
	if before != nil && after != nil {
		return model.TaskStep{}, nil, nil, invalidInput("before and after are mutually exclusive.")
	}
	for _, anchor := range []**string{&before, &after} {
		if *anchor == nil {
			continue
		}
		canonical, err := codec.CanonicalID(**anchor)
		if err != nil {
			return model.TaskStep{}, nil, nil, invalidInput(err.Error())
		}
		*anchor = &canonical
	}
	return model.TaskStep{ID: id, Title: title, Description: description, Status: value}, before, after, nil
}

func ValidateChanges(changes Changes) error {
	if changes.Title == nil && changes.Description == nil && changes.Status == nil {
		return invalidInput("At least one step field must be provided.")
	}
	if changes.Title != nil {
		if err := codec.ValidateTitle(*changes.Title); err != nil {
			return invalidInput(err.Error())
		}
	}
	if changes.Description != nil {
		if err := codec.ValidateDescription(*changes.Description); err != nil {
			return invalidInput(err.Error())
		}
	}
	if changes.Status != nil && !changes.Status.Valid() {
		return invalidInput("Step status must be todo, in_progress, done or skipped.")
	}
	return nil
}

func CanonicalPlacement(placement Placement) (Placement, error) {
	count := 0
	for _, value := range []*string{placement.Before, placement.After, placement.Position} {
		if value != nil {
			count++
		}
	}
	if count != 1 {
		return placement, invalidInput("Exactly one of before, after or position must be provided.")
	}
	if placement.Position != nil && *placement.Position != "first" && *placement.Position != "last" {
		return placement, invalidInput("Step position must be first or last.")
	}
	for _, anchor := range []**string{&placement.Before, &placement.After} {
		if *anchor == nil {
			continue
		}
		canonical, err := codec.CanonicalID(**anchor)
		if err != nil {
			return placement, invalidInput(err.Error())
		}
		*anchor = &canonical
	}
	return placement, nil
}

// StepAbsence records only a child absence established after parent admission.
type StepAbsence struct {
	Version int64
	Cause   error
}

func (err *StepAbsence) Error() string { return "step is currently absent" }
func (err *StepAbsence) Unwrap() error { return err.Cause }

func EncodingFault(err error) error {
	var limit *codec.LimitError
	if errors.As(err, &limit) {
		return &model.Fault{Code: "steps_limit_exceeded", Message: "Task steps exceed the encoded resource limit.", Cause: err,
			StepsLimit: &model.StepsLimitDetails{EncodedBytes: limit.EncodedBytes, MaxEncodedBytes: codec.MaxEncodedBytes}}
	}
	return err
}
