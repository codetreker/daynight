package task

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func goalRelationIdentity(principal model.Principal, projectID, goalID string) (string, string, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return "", "", err
	}
	projectID, err := model.CanonicalID(projectID)
	if err != nil {
		return "", "", err
	}
	goalID, err = model.CanonicalID(goalID)
	return projectID, goalID, err
}

func (s *Tasks) ShowGoalDependencies(ctx context.Context, principal model.Principal, projectID, goalID string, request model.PageRequest) (taskcore.GoalDependencies, error) {
	projectID, goalID, err := goalRelationIdentity(principal, projectID, goalID)
	if err != nil {
		return taskcore.GoalDependencies{}, err
	}
	if request.Limit == 0 {
		request.Limit = 20
	}
	if request.Limit < 1 || request.Limit > 50 {
		return taskcore.GoalDependencies{}, &model.Fault{Code: "invalid_input", Message: "limit must be between 1 and 50."}
	}
	scope := query.GoalPageScope{ProjectID: projectID, GoalID: goalID, UserID: principal.UserID, Limit: request.Limit}
	after, err := query.GoalPageAfter(request.Cursor, scope)
	if err != nil {
		return taskcore.GoalDependencies{}, err
	}
	result := taskcore.GoalDependencies{GoalID: goalID, Prerequisites: []taskcore.GoalDependencyPrerequisite{}, Successors: []taskcore.GoalDependencyTarget{}}
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		dao := snapshot.GoalRelationDAO()
		source, err := dao.Source(ctx, projectID, goalID, principal.UserID)
		if err != nil {
			return projectcore.ProjectWriteError(err)
		}
		if err := taskcore.RequireGoalRelationSource(source, false); err != nil {
			return err
		}
		result.CanEdit = source.CanEdit
		if source.CanEdit {
			result.Revision = &source.Revision
		}
		edges, err := dao.Prerequisites(ctx, projectID, goalID, principal.UserID)
		if err != nil {
			return err
		}
		if len(edges) > taskcore.GoalPrerequisiteLimit {
			return fmt.Errorf("stored Goal prerequisites exceed limit")
		}
		for _, edge := range edges {
			entry := taskcore.GoalDependencyPrerequisite{Target: edge.Target}
			if source.CanEdit {
				id := edge.ID
				entry.EdgeID = &id
			}
			result.Prerequisites = append(result.Prerequisites, entry)
			if edge.Status != model.TaskDone {
				result.CompletionBlocked = true
			}
		}
		targets, err := dao.Successors(ctx, projectID, goalID, principal.UserID, after, request.Limit+1)
		if err != nil {
			return err
		}
		if len(targets) > request.Limit {
			targets = targets[:request.Limit]
			cursor := query.EncodeGoalCursor(scope, targets[len(targets)-1].GoalID)
			result.NextCursor = &cursor
		}
		result.Successors = targets
		return nil
	})
	if err != nil {
		return taskcore.GoalDependencies{}, fmt.Errorf("read Goal dependencies: %w", err)
	}
	return result, nil
}

func (s *Tasks) EditGoalDependencies(ctx context.Context, principal model.Principal, projectID, goalID string, input taskcore.GoalDependencyEdit) (taskcore.GoalDependencyReceipt, error) {
	projectID, goalID, err := goalRelationIdentity(principal, projectID, goalID)
	if err != nil {
		return taskcore.GoalDependencyReceipt{}, err
	}
	if err := taskcore.ValidateGoalDependencyEdit(input); err != nil {
		return taskcore.GoalDependencyReceipt{}, err
	}
	ctx = withTaskWriteOperations(ctx, scopepolicy.TaskDependencies)
	ctx, cancel := context.WithTimeout(ctx, goalLifecycleTimeout)
	defer cancel()
	var result taskcore.GoalDependencyReceipt
	completion, err := s.store.WriteProject(ctx, projectID, func(scope store.ProjectWriteScope) error {
		dao := scope.GoalRelationDAO()
		if err := dao.LockTeam(ctx); err != nil {
			return err
		}
		facts, err := dao.Admission(ctx, goalID, principal.UserID, taskcore.GoalDependencyCandidates(input))
		if err != nil {
			return err
		}
		if err := taskcore.RequireGoalRelationSource(facts.Source, true); err != nil {
			return err
		}
		if err := checkTaskWriteScope(ctx, principal); err != nil {
			return err
		}
		edges, changed, err := taskcore.PrepareGoalRelations(ctx, dao, goalID, input, facts)
		if err != nil {
			return err
		}
		result = taskcore.GoalDependencyReceipt{GoalID: goalID, Revision: facts.Source.Revision, Changed: changed}
		if changed {
			if err := dao.Save(ctx, goalID, facts.Source.Revision, edges); err != nil {
				return err
			}
			result.Revision++
		}
		return nil
	})
	if err != nil {
		return taskcore.GoalDependencyReceipt{}, fmt.Errorf("edit Goal dependencies: %w", goalLifecycleError(redactTaskWriteError(ctx, projectcore.ProjectWriteError(err)), true))
	}
	if completion.Outcome != store.TransactionCommitted {
		return taskcore.GoalDependencyReceipt{}, fmt.Errorf("edit Goal dependencies: transaction did not confirm commit")
	}
	return result, nil
}
