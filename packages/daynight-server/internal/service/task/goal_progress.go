package task

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type goalProgressReader interface {
	GoalProgresses(context.Context, string, []string) (map[string]model.GoalProgress, error)
}

func decorateGoalProgress(ctx context.Context, reader goalProgressReader, projectID string, tasks []model.Task) error {
	ids := make([]string, 0, len(tasks))
	for _, task := range tasks {
		if task.Type == model.TaskTypeGoal {
			ids = append(ids, task.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	progresses, err := reader.GoalProgresses(ctx, projectID, ids)
	if err != nil {
		return err
	}
	for i := range tasks {
		if tasks[i].Type != model.TaskTypeGoal {
			continue
		}
		progress, ok := progresses[tasks[i].ID]
		if !ok {
			return fmt.Errorf("goal progress missing for %s", tasks[i].ID)
		}
		tasks[i].Progress = &progress
	}
	return nil
}

func expandPriorityPage(ctx context.Context, reader store.TaskReader, projectID string, items []store.TaskPriorityItem) error {
	ids := make([]string, len(items))
	for i := range items {
		ids[i] = items[i].Task.ID
	}
	if len(ids) == 0 {
		return nil
	}
	bodies, err := reader.TaskBodies(ctx, projectID, ids)
	if err != nil {
		return err
	}
	if err := decorateGoalProgress(ctx, reader, projectID, bodies); err != nil {
		return err
	}
	byID := make(map[string]model.Task, len(bodies))
	for _, body := range bodies {
		byID[body.ID] = body
	}
	for i := range items {
		full, ok := byID[items[i].Task.ID]
		if !ok {
			return fmt.Errorf("selected task body missing for %s", items[i].Task.ID)
		}
		items[i].Task = full
	}
	return nil
}
