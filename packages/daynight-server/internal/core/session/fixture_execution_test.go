package session

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// New constructs the test execution against the fixture's isolated store.
func New(db store.SessionWriter, files ...filestorage.Storage) *Execution {
	var storage filestorage.Storage
	if len(files) > 0 {
		storage = files[0]
	}
	engine := NewEngine(storage)
	c := &fixtureCoordinator{engine: engine}
	c.write = func(ctx context.Context, op *Operation, fn func(store.SessionScope) error) error {
		completion, err := db.WriteSession(ctx, fn)
		op.Finish(completion.Outcome)
		if err != nil {
			var transaction *store.TransactionError
			if completion.Outcome == store.TransactionNotCommitted && errors.As(err, &transaction) && !transaction.CommitAttempted && !transaction.CleanupFailed {
				var refusal *model.Fault
				if errors.As(err, &refusal) {
					return refusal
				}
				if errors.Is(err, model.ErrNotFound) {
					return fault("not_found", "Session was not found.")
				}
			}
			return err
		}
		if completion.Outcome != store.TransactionCommitted {
			return errors.New("session transaction did not confirm commit")
		}
		return nil
	}
	return NewExecution(engine, c.browser, c.controller, c.archive, c.terminal, c.registerTask, c.registerTest, c.controllerGrant, c.taskQuery, c.credential, c.botRun, c.registerTerminal, c.authorize)
}

type fixtureCoordinator struct {
	engine *Engine
	write  TransactionRunner
}

// loadSession acquires the Bot before the Session when a binding exists.
func loadSession(ctx context.Context, op *Operation, scope store.SessionScope, id string) (*Access, error) {
	botID, err := scope.SessionDAO().SessionBotID(ctx, id)
	if err != nil {
		if errors.Is(err, model.ErrNotFound) {
			op.MissingSession(id)
		}
		return nil, err
	}
	var bot *model.Bot
	if botID != nil {
		value, err := scope.BotDAO().Bot(ctx, *botID)
		if err != nil {
			if errors.Is(err, model.ErrNotFound) {
				op.MissingSession(id)
				return nil, &model.Fault{Code: "not_found", Message: "Bot was not found."}
			}
			return nil, err
		}
		bot = &value
		if err := op.CheckBot(id, bot); err != nil {
			return nil, err
		}
	}
	return op.Load(ctx, scope, id, bot)
}

func authorizeTest(ctx context.Context, op *Operation, scope store.SessionScope, p model.Principal, access *Access) error {
	if err := op.LockCredential(ctx, scope, p); err != nil {
		return err
	}
	if err := op.CheckTestOwner(access, p); err != nil {
		return err
	}
	authority := access.Authority()
	if authority.ParentCredentialID != "" {
		parent := model.Principal{Kind: model.PATCredential, UserID: authority.OwnerID, CredentialID: authority.ParentCredentialID}
		if err := op.LockCredential(ctx, scope, parent); err != nil {
			return err
		}
	}
	return nil
}

// browser selects a Task or independent Test Session while retaining the
// original database lock order and one transaction for admission and work.
func (s *fixtureCoordinator) browser(ctx context.Context, principal model.Principal, project, taskID, id string, work func(*Access) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op, func(scope store.SessionScope) error {
		if project == "" && taskID == "" {
			access, err := loadSession(ctx, op, scope, id)
			if err != nil {
				return err
			}
			if err = op.CheckTestScope(access); err != nil {
				return err
			}
			if err = authorizeTest(ctx, op, scope, principal, access); err != nil {
				return err
			}
			if err = op.BindTestBrowser(ctx, access); err != nil {
				return err
			}
			return work(access)
		}
		task, err := op.LockTask(ctx, scope, project, taskID)
		if err != nil {
			return err
		}
		if err = op.LockCredential(ctx, scope, principal); err != nil {
			return err
		}
		admin, err := op.ProjectAdmin(ctx, scope, principal, project)
		if err != nil {
			return err
		}
		access, err := loadSession(ctx, op, scope, id)
		if err != nil {
			return err
		}
		if err = op.BindTaskBrowser(ctx, access, task, principal, project, taskID, admin); err != nil {
			return err
		}
		return work(access)
	})
}

// controller revalidates the current owner and connection fence in the same
// transaction as the requested operation.
func (s *fixtureCoordinator) controller(ctx context.Context, fence sp.ControllerFence, work func(*Access) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op, func(scope store.SessionScope) error {
		location, err := scope.SessionDAO().SessionLocation(ctx, fence.SessionID)
		if err != nil {
			if errors.Is(err, model.ErrNotFound) {
				op.MissingSession(fence.SessionID)
			}
			return err
		}
		task, err := op.LockTask(ctx, scope, location.ProjectID, location.TaskID)
		if err != nil {
			return err
		}
		access, err := loadSession(ctx, op, scope, fence.SessionID)
		if err != nil {
			return err
		}
		authority := access.Authority()
		owner := model.Principal{Kind: model.PATCredential, UserID: authority.OwnerID, CredentialID: authority.ConnectionCredentialID}
		if authority.Test {
			if err = authorizeTest(ctx, op, scope, owner, access); err != nil {
				return err
			}
		} else {
			if err = op.LockCredential(ctx, scope, owner); err != nil {
				return err
			}
			if _, err = op.ProjectAdmin(ctx, scope, owner, authority.ProjectID); err != nil {
				return err
			}
		}
		if err = op.BindController(access, task, fence); err != nil {
			return err
		}
		return work(access)
	})
}

func (s *fixtureCoordinator) archive(ctx context.Context, principal model.Principal, project, taskID, id string, finalize bool, work func(*Access) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op, func(scope store.SessionScope) error {
		task, deleted, err := op.LockArchiveTask(ctx, scope, project, taskID, finalize)
		if err != nil {
			return err
		}
		if project != "" {
			if err = op.LockCredential(ctx, scope, principal); err != nil {
				return err
			}
			if _, err = op.ProjectAdmin(ctx, scope, principal, project); err != nil {
				return err
			}
		}
		access, err := loadSession(ctx, op, scope, id)
		if err != nil {
			return err
		}
		if err = op.BindArchive(access, task, principal, project, taskID, deleted); err != nil {
			return err
		}
		if project == "" {
			if err = authorizeTest(ctx, op, scope, principal, access); err != nil {
				return err
			}
		}
		return work(access)
	})
}

func (s *fixtureCoordinator) terminal(ctx context.Context, principal model.Principal, project, taskID, id string, finalize bool, work func(*TerminalAccess) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op, func(scope store.SessionScope) error {
		task, deleted, err := op.LockArchiveTask(ctx, scope, project, taskID, finalize)
		if err != nil {
			return err
		}
		if err = op.LockCredential(ctx, scope, principal); err != nil {
			return err
		}
		admin, err := op.ProjectAdmin(ctx, scope, principal, project)
		if err != nil {
			return err
		}
		access, err := op.LoadTerminal(ctx, scope, id)
		if err != nil {
			return err
		}
		if err = op.BindTerminal(access, task, principal, project, taskID, deleted, admin); err != nil {
			return err
		}
		return work(access)
	})
}

func (s *fixtureCoordinator) registerTask(ctx context.Context, p model.Principal, project, taskID string, input sp.Registration, work func(*Operation, store.SessionScope, *Access) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op, func(scope store.SessionScope) error {
		if err := scope.SessionDAO().LockTaskRegistration(ctx, project, taskID); err != nil {
			return err
		}
		task, err := op.LockTask(ctx, scope, project, taskID)
		if err != nil {
			return err
		}
		if err = op.LockCredential(ctx, scope, p); err != nil {
			return err
		}
		if _, err = op.ProjectAdmin(ctx, scope, p, project); err != nil {
			return err
		}
		if err = op.CheckRegistration(task, p, input); err != nil {
			return err
		}
		id, err := scope.SessionDAO().FindTaskRegistration(ctx, project, input.RegistrationID, taskID, input.ClaimID)
		if errors.Is(err, model.ErrNotFound) {
			return work(op, scope, nil)
		}
		if err != nil {
			return err
		}
		access, err := loadSession(ctx, op, scope, id)
		if err != nil {
			return err
		}
		return work(op, scope, access)
	})
}

func (s *fixtureCoordinator) registerTest(ctx context.Context, p model.Principal, input sp.TestRegistration, work func(*Operation, store.SessionScope, *Access) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op, func(scope store.SessionScope) error {
		if err := op.LockCredential(ctx, scope, p); err != nil {
			return err
		}
		if err := scope.SessionDAO().LockTestOwner(ctx, p.UserID); err != nil {
			return err
		}
		id, botID, err := scope.SessionDAO().FindTestRegistration(ctx, p.UserID, input.RegistrationID, input.TestExecutionID)
		if errors.Is(err, model.ErrNotFound) {
			return work(op, scope, nil)
		}
		if err != nil {
			return err
		}
		if botID != nil {
			return &model.Fault{Code: "forbidden", Message: "Session access is not available."}
		}
		access, err := loadSession(ctx, op, scope, id)
		if err != nil {
			return err
		}
		if err = op.CheckTestRegistration(access, input); err != nil {
			return err
		}
		if err = authorizeTest(ctx, op, scope, p, access); err != nil {
			return err
		}
		return work(op, scope, access)
	})
}

func (s *fixtureCoordinator) controllerGrant(ctx context.Context, hash []byte, work func(*Access) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op, func(scope store.SessionScope) error {
		location, err := scope.SessionDAO().SessionLocationByGrant(ctx, hash)
		if errors.Is(err, model.ErrNotFound) {
			return &model.Fault{Code: "forbidden", Message: "Session access is not available."}
		}
		if err != nil {
			return err
		}
		task, err := op.LockTask(ctx, scope, location.ProjectID, location.TaskID)
		if err != nil {
			return err
		}
		access, err := loadSession(ctx, op, scope, location.SessionID)
		if err != nil {
			return err
		}
		authority := access.Authority()
		parent := model.Principal{Kind: model.PATCredential, UserID: authority.OwnerID, CredentialID: authority.ParentCredentialID}
		if authority.Test {
			if err = authorizeTest(ctx, op, scope, parent, access); err != nil {
				return err
			}
		} else {
			if err = op.LockCredential(ctx, scope, parent); err != nil {
				return err
			}
			if _, err = op.ProjectAdmin(ctx, scope, parent, authority.ProjectID); err != nil {
				return err
			}
		}
		if err = op.BindControllerGrant(access, task, hash); err != nil {
			return err
		}
		return work(access)
	})
}

func (s *fixtureCoordinator) taskQuery(ctx context.Context, principal model.Principal, project, taskID string, work func(*Operation, store.SessionScope, *TaskAccess, bool, func(string) (*Access, error)) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op, func(scope store.SessionScope) error {
		task, err := op.LockTask(ctx, scope, project, taskID)
		if err != nil {
			return err
		}
		if err = op.LockCredential(ctx, scope, principal); err != nil {
			return err
		}
		admin, err := op.ProjectAdmin(ctx, scope, principal, project)
		if err != nil {
			return err
		}
		load := func(id string) (*Access, error) { return loadSession(ctx, op, scope, id) }
		return work(op, scope, task, admin, load)
	})
}

func (s *fixtureCoordinator) credential(ctx context.Context, principal model.Principal, work func(*Operation, store.SessionScope) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op, func(scope store.SessionScope) error {
		if err := op.LockCredential(ctx, scope, principal); err != nil {
			return err
		}
		return work(op, scope)
	})
}

func (s *fixtureCoordinator) botRun(ctx context.Context, p model.Principal, workerID, id string, prepare func(model.Bot) error, check func(model.Bot, *Access) error, work func(*Operation, store.SessionScope, model.Bot, *Access, func(model.Principal) error) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op, func(scope store.SessionScope) error {
		if p.Kind != model.PATCredential {
			return &model.Fault{Code: "forbidden", Message: "Session access is not available."}
		}
		if err := op.LockCredential(ctx, scope, p); err != nil {
			return err
		}
		bot, err := scope.BotDAO().Bot(ctx, id)
		if errors.Is(err, model.ErrNotFound) {
			return &model.Fault{Code: "not_found", Message: "Bot was not found."}
		}
		if err != nil {
			return err
		}
		if bot.OwnerUserID != p.UserID || bot.WorkerID != workerID {
			return &model.Fault{Code: "forbidden", Message: "Session access is not available."}
		}
		if bot.Deletion != nil {
			return &model.Fault{Code: "resource_conflict", Message: "Bot is deleted."}
		}
		if prepare != nil {
			if err = prepare(bot); err != nil {
				return err
			}
		}
		var access *Access
		if bot.SessionID != nil {
			if err = op.CheckBot(*bot.SessionID, &bot); err != nil {
				return err
			}
			access, err = op.Load(ctx, scope, *bot.SessionID, &bot)
			if err != nil {
				return err
			}
			if check != nil {
				if err = check(bot, access); err != nil {
					return err
				}
			}
			if err = op.LockCredential(ctx, scope, p); err != nil {
				return err
			}
			if err = op.CheckTestOwner(access, p); err != nil {
				return err
			}
			authority := access.Authority()
			if authority.ParentCredentialID != "" {
				parent := model.Principal{Kind: model.PATCredential, UserID: authority.OwnerID, CredentialID: authority.ParentCredentialID}
				if err = op.LockCredential(ctx, scope, parent); err != nil {
					return err
				}
			}
		}
		return work(op, scope, bot, access, func(principal model.Principal) error { return op.LockCredential(ctx, scope, principal) })
	})
}

func (s *fixtureCoordinator) registerTerminal(ctx context.Context, p model.Principal, project, taskID string, work func(*Operation, store.SessionScope, *TaskAccess) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op, func(scope store.SessionScope) error {
		if err := scope.SessionDAO().LockTaskRegistration(ctx, project, taskID); err != nil {
			return err
		}
		task, err := op.LockTask(ctx, scope, project, taskID)
		if err != nil {
			return err
		}
		if err = op.LockCredential(ctx, scope, p); err != nil {
			return err
		}
		if _, err = op.ProjectAdmin(ctx, scope, p, project); err != nil {
			return err
		}
		return work(op, scope, task)
	})
}

func (s *fixtureCoordinator) authorize(ctx context.Context, op *Operation, scope store.SessionScope, p model.Principal, authority Authority) (bool, error) {
	if err := op.LockCredential(ctx, scope, p); err != nil {
		return false, err
	}
	if !authority.Test {
		return op.ProjectAdmin(ctx, scope, p, authority.ProjectID)
	}
	if p.UserID != authority.OwnerID {
		return false, &model.Fault{Code: "forbidden", Message: "Session access is not available."}
	}
	if authority.ParentCredentialID != "" {
		parent := model.Principal{Kind: model.PATCredential, UserID: authority.OwnerID, CredentialID: authority.ParentCredentialID}
		if err := op.LockCredential(ctx, scope, parent); err != nil {
			return false, err
		}
	}
	return true, nil
}

func testTransact(s *Execution, db store.SessionWriter, ctx context.Context, fn func(*operationTx) error) error {
	op, err := s.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	completion, err := db.WriteSession(ctx, func(scope store.SessionScope) error {
		return fn(&operationTx{scope: scope, dao: scope.SessionDAO(), bot: scope.BotDAO(), op: op})
	})
	op.Finish(completion.Outcome)
	return err
}
