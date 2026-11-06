package session

import (
	"bytes"
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// Access is a Session authorization and locked record bound to one Operation
// and transaction callback. Callers must not retain it outside that callback.
type Access struct {
	tx     *operationTx
	record *record
	task   task
	write  bool
}

type TaskAccess struct{ task task }

type TerminalAccess struct {
	tx     *operationTx
	record *terminalRecord
	task   task
	write  bool
}

type Authority struct {
	Test                                                           bool
	ProjectID, OwnerID, ParentCredentialID, ConnectionCredentialID string
}

func (op *Operation) CheckRegistration(t *TaskAccess, p model.Principal, input sp.Registration) error {
	w := t.task.Worker
	if w == nil || t.task.Status != "in_progress" || w.State != model.WorkerActive || w.AgentControlMode != model.AgentControlModeWeb || w.UserID != p.UserID || w.ClaimID != input.ClaimID || w.WorkerID != input.WorkerID || w.WorktreeID != input.WorktreeID || string(w.Agent) != input.Provider {
		return conflict()
	}
	return nil
}

func (a *Access) Authority() Authority {
	r := a.record
	return Authority{Test: r.Snapshot.TestExecutionID != "", ProjectID: r.Snapshot.Identity.ProjectID, OwnerID: r.Owner, ParentCredentialID: r.Parent, ConnectionCredentialID: r.ConnectionParent}
}

// LockTask leaves independent Test Sessions without a Task lock.
func (op *Operation) LockTask(ctx context.Context, scope store.SessionScope, project, id string) (*TaskAccess, error) {
	_, tx := op.scoped(scope)
	t, err := scopeTask(ctx, tx, project, id)
	return &TaskAccess{task: t}, err
}

func (op *Operation) LockArchiveTask(ctx context.Context, scope store.SessionScope, project, id string, finalize bool) (*TaskAccess, bool, error) {
	_, tx := op.scoped(scope)
	t, deleted, err := scopeArchiveTask(ctx, tx, project, id, finalize)
	return &TaskAccess{task: t}, deleted, err
}

func (op *Operation) LockCredential(ctx context.Context, scope store.SessionScope, p model.Principal) error {
	s, tx := op.scoped(scope)
	return credential(ctx, tx, p, s.now())
}

func (op *Operation) ProjectAdmin(ctx context.Context, scope store.SessionScope, p model.Principal, project string) (bool, error) {
	access, err := scope.SessionDAO().ProjectAccess(ctx, p.UserID, project)
	if errors.Is(err, store.ErrSessionProjectNotFound) {
		return false, fault("not_found", "Session is not available.")
	}
	if errors.Is(err, model.ErrNotFound) {
		return false, denied()
	}
	return access.Role == model.ProjectAdmin, err
}

// CheckBot applies the deletion barrier after the service locks the Bot.
func (op *Operation) CheckBot(id string, bot *model.Bot) error {
	if bot == nil {
		return nil
	}
	if bot.Deletion != nil {
		op.engine.DiscardBotSession(id)
		return fault("resource_conflict", "Bot is deleted.")
	}
	if bot.SessionID == nil || *bot.SessionID != id {
		return conflict()
	}
	return nil
}

func (op *Operation) MissingSession(id string) { op.engine.DiscardBotSession(id) }

// Load requires the service to acquire any associated Bot lock first.
func (op *Operation) Load(ctx context.Context, scope store.SessionScope, id string, bot *model.Bot) (*Access, error) {
	_, tx := op.scoped(scope)
	r, err := loadWithBot(ctx, tx, id, bot)
	if err != nil {
		if errors.Is(err, model.ErrNotFound) {
			op.engine.DiscardBotSession(id)
		}
		return nil, err
	}
	return &Access{tx: tx, record: r}, nil
}

func (op *Operation) CheckTestOwner(a *Access, p model.Principal) error {
	if p.UserID != a.record.Owner {
		return denied()
	}
	return nil
}

func (op *Operation) CheckTestRegistration(a *Access, input sp.TestRegistration) error {
	if a.record.BotID != nil || !jsonEqual(a.record.Registration, encode(input)) {
		return conflict()
	}
	return nil
}

func (op *Operation) CheckTestScope(a *Access) error {
	if a.record.Snapshot.TestExecutionID == "" {
		return conflict()
	}
	return nil
}

func (op *Operation) BindTestBrowser(ctx context.Context, a *Access) error {
	s := &Execution{Engine: op.engine}
	if err := s.archiveExpired(ctx, a.tx, a.record); err != nil {
		return err
	}
	a.write = true
	return nil
}

func (op *Operation) BindTaskBrowser(ctx context.Context, a *Access, t *TaskAccess, p model.Principal, project, taskID string, admin bool) error {
	r := a.record
	if r.Snapshot.TestExecutionID != "" || r.Snapshot.Identity.ProjectID != project || r.Snapshot.Identity.TaskID != taskID || !current(t.task, r) {
		return conflict()
	}
	s := &Execution{Engine: op.engine}
	if err := s.archiveExpired(ctx, a.tx, r); err != nil {
		return err
	}
	a.task, a.write = t.task, admin || r.Owner == p.UserID
	return nil
}

func (op *Operation) BindController(a *Access, t *TaskAccess, f sp.ControllerFence) error {
	r, s := a.record, op.engine
	if r.ServerInstance == nil || *r.ServerInstance != s.instance || r.Live == nil || r.Snapshot.ControllerFence != f || r.ConnectionExpiry == nil || !s.now().Before(*r.ConnectionExpiry) || r.Snapshot.Lifecycle == "archived" || r.DrainUntil != nil && !s.now().Before(*r.DrainUntil) {
		return conflict()
	}
	if !active(t.task, r) && r.Snapshot.Lifecycle != "draining" {
		return conflict()
	}
	a.task = t.task
	return nil
}

func (op *Operation) BindControllerGrant(a *Access, t *TaskAccess, hash []byte) error {
	r, s := a.record, op.engine
	if !bytes.Equal(hash, r.GrantHash) || r.GrantExpiry == nil || !s.now().Before(*r.GrantExpiry) || r.Consumed && r.GrantKind == "bootstrap" || !active(t.task, r) {
		return denied()
	}
	a.task = t.task
	return nil
}

func (op *Operation) BindArchive(a *Access, t *TaskAccess, p model.Principal, project, taskID string, deleted bool) error {
	r := a.record
	v := r.Snapshot
	if v.Identity.ProjectID != project || v.Identity.TaskID != taskID || (project == "") != (v.TestExecutionID != "") {
		return conflict()
	}
	if deleted && (p.Kind != model.PATCredential || p.UserID != r.Owner) {
		return denied()
	}
	a.task = t.task
	return nil
}

func (op *Operation) LoadTerminal(ctx context.Context, scope store.SessionScope, id string) (*TerminalAccess, error) {
	_, tx := op.scoped(scope)
	r, err := loadTerminal(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	return &TerminalAccess{tx: tx, record: r}, nil
}

func (op *Operation) BindTerminal(a *TerminalAccess, t *TaskAccess, p model.Principal, project, taskID string, deleted, admin bool) error {
	r := a.record
	if r.Owner.ProjectID != project || r.Owner.TaskID != taskID {
		return conflict()
	}
	if deleted {
		if err := terminalOwner(p, r); err != nil {
			return err
		}
	}
	a.task, a.write = t.task, admin || p.UserID == r.Owner.OwnerUserID
	return nil
}

func (op *Operation) scoped(scope store.SessionScope) (*Execution, *operationTx) {
	return &Execution{Engine: op.engine}, &operationTx{scope: scope, dao: scope.SessionDAO(), bot: scope.BotDAO(), op: op}
}
