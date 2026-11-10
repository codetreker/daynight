package session

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type historyScopeOperations struct {
	lockTask    func(*core.Operation, context.Context, store.SessionScope, string, string) (*core.TaskAccess, error)
	credential  func(*core.Operation, context.Context, store.SessionScope, model.Principal) error
	project     func(*core.Operation, context.Context, store.SessionScope, model.Principal, string) error
	load        func(context.Context, *core.Operation, store.SessionScope, string) (*core.Access, error)
	bindRead    func(*core.Operation, *core.Access, *core.TaskAccess, string, string) error
	bindArchive func(*core.Operation, *core.Access, *core.TaskAccess, model.Principal, string, string, bool) error
}

func historyScopeBindings() historyScopeOperations {
	return historyScopeOperations{
		lockTask:    (*core.Operation).LockTask,
		credential:  (*core.Operation).LockTaskReadCredential,
		project:     (*core.Operation).CheckProjectAccess,
		load:        loadSession,
		bindRead:    (*core.Operation).BindTaskRead,
		bindArchive: (*core.Operation).BindArchive,
	}
}

func (s *Service) taskReadQuery(ctx context.Context, p model.Principal, project, taskID string, work func(*core.Operation, store.SessionScope, *core.TaskAccess, func(string) (*core.Access, error)) error) error {
	if project == "" || taskID == "" {
		return &model.Fault{Code: "forbidden", Message: "Task history requires a Task scope."}
	}
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op.Finish, func(scope store.SessionScope) error {
		task, e := s.historyOps.lockTask(op, ctx, scope, project, taskID)
		if e != nil {
			return e
		}
		if e = s.historyOps.credential(op, ctx, scope, p); e != nil {
			return e
		}
		if e = s.historyOps.project(op, ctx, scope, p, project); e != nil {
			return e
		}
		return work(op, scope, task, func(id string) (*core.Access, error) { return s.historyOps.load(ctx, op, scope, id) })
	})
}
func (s *Service) taskContentRead(ctx context.Context, p model.Principal, project, taskID, id string, work func(*core.Access) error) error {
	return s.taskReadQuery(ctx, p, project, taskID, func(op *core.Operation, scope store.SessionScope, task *core.TaskAccess, load func(string) (*core.Access, error)) error {
		a, err := load(id)
		if err != nil {
			return err
		}
		if err = s.historyOps.bindRead(op, a, task, project, taskID); err != nil {
			return err
		}
		return work(a)
	})
}
func (s *Service) taskArchiveRead(ctx context.Context, p model.Principal, project, taskID, id string, _ bool, work func(*core.Access) error) error {
	return s.taskReadQuery(ctx, p, project, taskID, func(op *core.Operation, scope store.SessionScope, task *core.TaskAccess, load func(string) (*core.Access, error)) error {
		a, err := load(id)
		if err != nil {
			return err
		}
		if err = s.historyOps.bindArchive(op, a, task, p, project, taskID, false); err != nil {
			return err
		}
		return work(a)
	})
}
