package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
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

func (s *TaskSync) Get(ctx context.Context, principal core.Principal, projectID string, input TaskSyncRequest) (core.TaskSync, error) {
	if err := requirePrincipal(principal); err != nil {
		return core.TaskSync{}, err
	}
	projectID, err := CanonicalID(projectID)
	if err != nil {
		return core.TaskSync{}, err
	}
	if input.Epoch != "" {
		canonical, err := CanonicalID(input.Epoch)
		if err != nil || canonical != input.Epoch {
			return core.TaskSync{}, invalidInput("Epoch must be a canonical UUID.")
		}
	} else if input.Since != nil {
		return core.TaskSync{}, invalidInput("Since requires an epoch.")
	}
	var result core.TaskSync
	var refusal *Fault
	err = s.store.ReadSnapshot(ctx, func(snapshot *store.Snapshot) error {
		if _, err := RequireProjectRead(ctx, snapshot, principal, projectID); err != nil {
			if errors.As(err, &refusal) {
				return nil
			}
			return err
		}
		var err error
		result.Project, err = snapshot.Project(ctx, projectID)
		if errors.Is(err, core.ErrNotFound) {
			refusal = &Fault{Code: "not_found", Message: "Project was not found.", Cause: err}
			return nil
		}
		if err != nil {
			return err
		}
		result.Epoch, err = snapshot.TaskCacheEpoch(ctx, projectID)
		if err != nil {
			return err
		}
		size, err := snapshot.TaskGraphSize(ctx, projectID)
		if err != nil {
			return err
		}
		if size.NodeCount > maxGraphNodes || size.EdgeCount > maxGraphEdges {
			refusal = &Fault{Code: "graph_limit_exceeded", Message: "Task graph exceeds the supported size.",
				GraphLimit: &GraphLimitDetails{NodeCount: size.NodeCount, EdgeCount: size.EdgeCount, MaxNodes: maxGraphNodes, MaxEdges: maxGraphEdges}}
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
		result.Tasks, err = snapshot.TaskSyncTasks(ctx, projectID, lower, graphTitlePreviewCharacters)
		if err != nil {
			return err
		}
		result.ObservedAt, err = snapshot.ObservedAt(ctx)
		return err
	})
	if err != nil {
		return core.TaskSync{}, fmt.Errorf("read task sync: %w", err)
	}
	if refusal != nil {
		return core.TaskSync{}, refusal
	}
	return result, nil
}
