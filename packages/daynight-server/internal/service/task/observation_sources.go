package task

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// Selected sources outlive their read-only snapshot as immutable lightweight
// facts. Live sampling and a fresh authorization snapshot run after release,
// so requests never hold one pool connection while waiting for another.
type selectedObservationSources struct {
	store.SessionReader
	values   map[string]store.TaskSessionSource
	failures map[string]error
}
type selectedObservationSnapshot struct {
	store.SnapshotScope
	reader store.SessionReader
}

func (s selectedObservationSnapshot) SessionDAO() store.SessionReader { return s.reader }
func (s selectedObservationSources) TaskSessionSources(_ context.Context, _ string, ids []string) ([]store.TaskSessionSource, error) {
	values := make([]store.TaskSessionSource, 0, len(ids))
	for _, id := range ids {
		if err := s.failures[id]; err != nil {
			return nil, err
		}
		if source, exists := s.values[id]; exists {
			values = append(values, source)
		}
	}
	return values, nil
}
func loadSelectedSources(ctx context.Context, snapshot store.SnapshotScope, projectID string, tasks []model.Task) (store.SnapshotScope, error) {
	tasks = observableExecutionTasks(tasks)
	selected := selectedObservationSources{values: make(map[string]store.TaskSessionSource, len(tasks)), failures: map[string]error{}}
	for start := 0; start < len(tasks); start += 200 {
		end := min(start+200, len(tasks))
		ids := make([]string, end-start)
		for i, t := range tasks[start:end] {
			ids[i] = t.ID
		}
		sources, err := snapshot.SessionDAO().TaskSessionSources(ctx, projectID, ids)
		if err != nil {
			if observationAuthorityFailure(err) || ctx.Err() != nil {
				return nil, err
			}
			for _, id := range ids {
				selected.failures[id] = err
			}
			continue
		}
		for _, source := range sources {
			selected.values[source.TaskID] = source
		}
	}
	return selectedObservationSnapshot{reader: selected}, nil
}

func observableExecutionTasks(tasks []model.Task) []model.Task {
	result := make([]model.Task, 0, len(tasks))
	for _, task := range tasks {
		if task.Type != model.TaskTypeGoal {
			result = append(result, task)
		}
	}
	return result
}
