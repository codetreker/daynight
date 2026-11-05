package service

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
)

func propertyValidationFault(err error) *model.Fault {
	var invalid *taskproperties.ValidationError
	if !errors.As(err, &invalid) {
		return nil
	}
	return &model.Fault{Code: "invalid_input", Message: invalid.Error(), Cause: err}
}

func propertyInputFault(err error) error {
	if fault := propertyValidationFault(err); fault != nil {
		return fault
	}
	return err
}

func (s *Tasks) SetProperty(ctx context.Context, principal model.Principal, projectID, id, name, valueText string, version int64) (model.Task, error) {
	if err := requirePrincipal(principal); err != nil {
		return model.Task{}, err
	}
	value, err := taskproperties.ParseInput(name, valueText)
	if err != nil {
		return model.Task{}, propertyInputFault(err)
	}
	return s.versionedWrite(ctx, principal, projectID, id, version, func(_ *store.ProjectTx, current model.Task) (taskMutation, error) {
		values := currentTaskWrite(current)
		values.Properties[name] = value
		return taskMutation{id: current.ID, current: current, values: values, changed: !taskproperties.Equal(current.Properties, values.Properties)}, nil
	})
}

func (s *Tasks) RemoveProperty(ctx context.Context, principal model.Principal, projectID, id, name string, version int64) (model.Task, error) {
	if err := requirePrincipal(principal); err != nil {
		return model.Task{}, err
	}
	if err := taskproperties.CheckWritable(name); err != nil {
		return model.Task{}, propertyInputFault(err)
	}
	return s.versionedWrite(ctx, principal, projectID, id, version, func(_ *store.ProjectTx, current model.Task) (taskMutation, error) {
		values := currentTaskWrite(current)
		delete(values.Properties, name)
		return taskMutation{id: current.ID, current: current, values: values, changed: !taskproperties.Equal(current.Properties, values.Properties)}, nil
	})
}
