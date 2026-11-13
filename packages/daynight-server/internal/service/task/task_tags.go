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

// ReplaceTags replaces a Task or Goal's complete association set. A nil input
// preserves the set; a pointer to an empty slice clears it.
func (s *Tasks) ReplaceTags(ctx context.Context, principal model.Principal, projectID, id string, version int64, requested *[]string) (model.Task, error) {
	projectID, id, err := taskWriteIdentity(principal, projectID, id, version)
	if err != nil {
		return model.Task{}, err
	}
	var result model.Task
	completion, err := s.store.WriteProject(ctx, projectID, func(tx store.ProjectWriteScope) error {
		if _, err := s.writeOperations.requireProjectWrite(ctx, tx.ProjectDAO(), principal); err != nil {
			return err
		}
		current, err := tx.TaskDAO().Task(ctx, id)
		if errors.Is(err, model.ErrNotFound) {
			return taskcore.NotFound(err)
		}
		if err != nil {
			return err
		}
		ids, changed, err := prepareTagReplacement(ctx, tx, current, version, requested)
		if err != nil {
			return err
		}
		result = current
		if changed {
			observed, err := tx.TaskDAO().ObservedAt(ctx)
			if err != nil {
				return err
			}
			if err := tx.TaskTagDAO().ReplaceTaskTags(ctx, id, ids); err != nil {
				return err
			}
			if err := tx.TaskDAO().TouchTask(ctx, id, observed); err != nil {
				return err
			}
			result, err = tx.TaskDAO().Task(ctx, id)
			if err != nil {
				return err
			}
		}
		values := []model.Task{result}
		if err := decorateGoalProgress(ctx, tx.TaskDAO(), projectID, values); err != nil {
			return err
		}
		result = values[0]
		return admitTaskResponse(ctx, result, changed)
	})
	if err != nil {
		return model.Task{}, fmt.Errorf("replace task tags: %w", projectcore.ProjectWriteError(err))
	}
	if completion.Outcome != store.TransactionCommitted {
		return model.Task{}, errors.New("replace task tags: transaction did not confirm commit")
	}
	return result, nil
}

func prepareTagReplacement(ctx context.Context, tx store.ProjectWriteScope, current model.Task, version int64, requested *[]string) ([]string, bool, error) {
	ids, changed, err := taskcore.TagCandidate(current, version, requested)
	if err != nil || requested == nil {
		return ids, changed, err
	}
	tags, err := tx.TagDAO().ResolveTags(ctx, ids)
	if err != nil {
		return nil, false, err
	}
	if len(tags) != len(ids) {
		return nil, false, &model.Fault{Code: "tag_not_found", Message: "One or more tags were not found."}
	}
	return ids, changed, nil
}

func prepareCreateTags(ctx context.Context, tx store.ProjectWriteScope, requested []string) ([]string, error) {
	ids, err := taskcore.NormalizeTagIDs(requested)
	if err != nil || len(ids) == 0 {
		return ids, err
	}
	tags, err := tx.TagDAO().ResolveTags(ctx, ids)
	if err != nil {
		return nil, err
	}
	if len(tags) != len(ids) {
		return nil, &model.Fault{Code: "tag_not_found", Message: "One or more tags were not found."}
	}
	return ids, nil
}
