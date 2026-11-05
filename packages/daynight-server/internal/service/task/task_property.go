package task

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func (s *Tasks) SetProperty(ctx context.Context, principal model.Principal, projectID, id, name, valueText string, version int64) (model.Task, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.Task{}, err
	}
	value, err := taskcore.PropertyInput(name, valueText)
	if err != nil {
		return model.Task{}, err
	}
	return s.versionedWrite(ctx, principal, projectID, id, version, func(_ store.ProjectWriteScope, current model.Task) (taskcore.Mutation, error) {
		values, changed := taskcore.SetPropertyCandidate(current, name, value)
		return taskcore.Mutation{ID: current.ID, Current: current, Values: values, Changed: changed}, nil
	})
}

func (s *Tasks) RemoveProperty(ctx context.Context, principal model.Principal, projectID, id, name string, version int64) (model.Task, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.Task{}, err
	}
	if err := taskcore.CheckPropertyWritable(name); err != nil {
		return model.Task{}, err
	}
	return s.versionedWrite(ctx, principal, projectID, id, version, func(_ store.ProjectWriteScope, current model.Task) (taskcore.Mutation, error) {
		values, changed := taskcore.RemovePropertyCandidate(current, name)
		return taskcore.Mutation{ID: current.ID, Current: current, Values: values, Changed: changed}, nil
	})
}
