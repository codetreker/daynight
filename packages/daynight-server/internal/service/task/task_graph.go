package task

import (
	"context"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func (s *Tasks) Graph(ctx context.Context, principal model.Principal, projectID, taskID string) (model.TaskGraph, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.TaskGraph{}, err
	}
	projectID, err := model.CanonicalID(projectID)
	if err != nil {
		return model.TaskGraph{}, err
	}
	taskID, err = model.CanonicalID(taskID)
	if err != nil {
		return model.TaskGraph{}, err
	}
	var graph model.TaskGraph
	var refusal *model.Fault
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if _, err := projectcore.RequireProjectRead(ctx, snapshot.ProjectDAO(), principal, projectID); err != nil {
			if errors.As(err, &refusal) {
				return nil
			}
			return err
		}
		var err error
		graph.Project, err = snapshot.ProjectDAO().Project(ctx, projectID)
		if errors.Is(err, model.ErrNotFound) {
			refusal = &model.Fault{Code: "not_found", Message: "Project was not found.", Cause: err}
			return nil
		}
		if err != nil {
			return err
		}
		graph, refusal, err = taskcore.ReadGraph(ctx, snapshot.TaskDAO(), snapshot.ObservedAt, projectID, taskID, graph.Project)
		return err
	})
	if err != nil {
		return model.TaskGraph{}, fmt.Errorf("read task graph: %w", err)
	}
	if refusal != nil {
		return model.TaskGraph{}, refusal
	}
	return graph, nil
}
