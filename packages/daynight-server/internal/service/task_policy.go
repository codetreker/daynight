package service

import (
	"context"
	"slices"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func validateCandidate(ctx context.Context, tx store.ProjectWriteScope, id string, values store.TaskWrite) error {
	prerequisites, err := tx.TaskDAO().TasksByID(ctx, values.DependsOn)
	if err != nil {
		return err
	}
	known := make(map[string]bool, len(prerequisites))
	for _, prerequisite := range prerequisites {
		known[prerequisite.ID] = true
	}
	missing := make([]string, 0)
	for _, dependency := range values.DependsOn {
		if !known[dependency] {
			missing = append(missing, dependency)
		}
	}
	if len(missing) > 0 {
		return &model.Fault{Code: "invalid_input", Message: "Dependencies must identify tasks in this project.", TaskIDs: missing}
	}
	cycles := make([]string, 0)
	for _, dependency := range values.DependsOn {
		reachable, err := tx.TaskDAO().Reachable(ctx, dependency, id, store.DependencyReplacement{TaskID: id, DependsOn: values.DependsOn})
		if err != nil {
			return err
		}
		if reachable {
			cycles = append(cycles, dependency)
		}
	}
	if len(cycles) > 0 {
		return &model.Fault{Code: "dependency_cycle", Message: "Task dependencies would create a cycle.", TaskIDs: cycles}
	}
	if values.Status == model.TaskInProgress || values.Status == model.TaskDone {
		blocked := make([]string, 0)
		for _, prerequisite := range prerequisites {
			if prerequisite.Status != model.TaskDone {
				blocked = append(blocked, prerequisite.ID)
			}
		}
		if len(blocked) > 0 {
			slices.Sort(blocked)
			return &model.Fault{Code: "dependency_unsatisfied", Message: "Task prerequisites must be done.", TaskIDs: blocked}
		}
	}
	return nil
}
