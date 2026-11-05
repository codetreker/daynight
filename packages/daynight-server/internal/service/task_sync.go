package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type TaskSync struct {
	store   *store.Store
	overlap time.Duration
}

type TaskSyncRequest struct {
	Epoch string
	Since *time.Time
}

func NewTaskSync(database *store.Store, overlap time.Duration) *TaskSync {
	return &TaskSync{store: database, overlap: overlap}
}

func (s *TaskSync) Get(ctx context.Context, principal model.Principal, projectID string, input TaskSyncRequest) (model.TaskSync, error) {
	if err := requirePrincipal(principal); err != nil {
		return model.TaskSync{}, err
	}
	projectID, err := CanonicalID(projectID)
	if err != nil {
		return model.TaskSync{}, err
	}
	if input.Epoch != "" {
		canonical, err := CanonicalID(input.Epoch)
		if err != nil || canonical != input.Epoch {
			return model.TaskSync{}, invalidInput("Epoch must be a canonical UUID.")
		}
	} else if input.Since != nil {
		return model.TaskSync{}, invalidInput("Since requires an epoch.")
	}
	var result model.TaskSync
	var refusal *model.Fault
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		var err error
		result.ActorAccess, err = RequireProjectRead(ctx, snapshot.ProjectDAO(), principal, projectID)
		if err != nil {
			if errors.As(err, &refusal) {
				return nil
			}
			return err
		}
		result.Project, err = snapshot.ProjectDAO().Project(ctx, projectID)
		if errors.Is(err, model.ErrNotFound) {
			refusal = &model.Fault{Code: "not_found", Message: "Project was not found.", Cause: err}
			return nil
		}
		if err != nil {
			return err
		}
		result.Epoch, err = snapshot.TaskDAO().TaskCacheEpoch(ctx, projectID)
		if err != nil {
			return err
		}
		size, err := snapshot.TaskDAO().TaskGraphSize(ctx, projectID)
		if err != nil {
			return err
		}
		if size.NodeCount > maxGraphNodes || size.EdgeCount > maxGraphEdges {
			refusal = &model.Fault{Code: "graph_limit_exceeded", Message: "Task graph exceeds the supported size.",
				GraphLimit: &model.GraphLimitDetails{NodeCount: size.NodeCount, EdgeCount: size.EdgeCount, MaxNodes: maxGraphNodes, MaxEdges: maxGraphEdges}}
			return nil
		}
		result.Mode = "snapshot"
		var lower *time.Time
		if input.Epoch == result.Epoch {
			result.Mode = "delta"
			if input.Since != nil {
				boundary := input.Since.Add(-s.overlap)
				lower = &boundary
			}
		}
		result.Tasks, err = snapshot.TaskDAO().TaskSyncTasks(ctx, projectID, lower, graphTitlePreviewCharacters)
		if validation := propertyValidationFault(err); validation != nil {
			refusal = validation
			return nil
		}
		if err != nil {
			return err
		}
		people, err := snapshot.TaskDAO().TaskAssignees(ctx, projectID)
		if err != nil {
			return err
		}
		result.AssigneeVersions = make([]model.TaskAssigneeVersion, 0, len(people.Items))
		for _, person := range people.Items {
			result.AssigneeVersions = append(result.AssigneeVersions, model.TaskAssigneeVersion{UserID: person.UserID, Version: person.Version, HasProjectAccess: person.HasProjectAccess})
		}
		result.ObservedAt, err = snapshot.ObservedAt(ctx)
		return err
	})
	if err != nil {
		return model.TaskSync{}, fmt.Errorf("read task sync: %w", err)
	}
	if refusal != nil {
		return model.TaskSync{}, refusal
	}
	return result, nil
}
