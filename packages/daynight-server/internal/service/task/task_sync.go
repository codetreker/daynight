package task

import (
	"context"
	"errors"
	"fmt"
	"time"

	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/projection"
)

type TaskSync struct {
	store   store.SnapshotReader
	engine  SessionStateReader
	overlap time.Duration
}

type SessionStateReader interface {
	TaskListSessionStates(context.Context, []store.TaskSessionSource) (map[string]model.SessionListState, error)
}

type TaskSyncRequest struct {
	Epoch string
	Since *time.Time
}

func NewTaskSync(database store.SnapshotReader, engine SessionStateReader, overlap time.Duration) *TaskSync {
	return &TaskSync{store: database, engine: engine, overlap: overlap}
}

func (s *TaskSync) Get(ctx context.Context, principal model.Principal, projectID string, input TaskSyncRequest) (model.TaskSync, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.TaskSync{}, err
	}
	projectID, err := model.CanonicalID(projectID)
	if err != nil {
		return model.TaskSync{}, err
	}
	if err := projection.ValidateSync(input.Epoch, input.Since); err != nil {
		return model.TaskSync{}, err
	}
	var result model.TaskSync
	var refusal *model.Fault
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		var err error
		result.ActorAccess, err = projectcore.RequireProjectRead(ctx, snapshot.ProjectDAO(), principal, projectID)
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
		result, refusal, err = taskcore.ReadSync(ctx, snapshot.TaskDAO(), snapshot.ObservedAt, projectID, input.Epoch, input.Since, s.overlap, result)
		if err != nil || refusal != nil {
			return err
		}
		sources, err := snapshot.SessionDAO().CurrentTaskSessionSources(ctx, projectID)
		if err != nil {
			return err
		}
		result.Sessions, err = s.engine.TaskListSessionStates(ctx, sources)
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
