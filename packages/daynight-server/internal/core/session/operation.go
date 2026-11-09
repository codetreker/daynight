package session

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// Operation owns one transaction's transient drafts and commit notifications.
// It must stay within its caller's transaction and be closed on every path.
type Operation struct {
	engine    *Engine
	cells     map[string]*liveCell
	live      map[string]*liveSession
	committed []func()
	discarded []func()
	finished  bool
}

// TransactionRunner selects the application's Session scope and finishes each
// operation after the database has reported its durable outcome.
type TransactionRunner func(context.Context, *Operation, func(store.SessionScope) error) error
type BrowserPurpose uint8

const (
	BrowserAccess BrowserPurpose = iota
	TaskMessageAccess
	TaskReceiptAccess
)

type BrowserRunner func(context.Context, model.Principal, string, string, string, BrowserPurpose, func(*Access) error) error
type ControllerRunner func(context.Context, sp.ControllerFence, func(*Access) error) error
type ArchivePreflightRunner func(context.Context, model.Principal, string, string, string, ArchiveMode) (string, error)
type ArchiveRunner func(context.Context, model.Principal, string, string, string, bool, func(*Access) error) error
type TerminalRunner func(context.Context, model.Principal, string, string, string, bool, func(*TerminalAccess) error) error
type TaskRegistrationRunner func(context.Context, model.Principal, string, string, sp.Registration, func(*Operation, store.SessionScope, *Access) error) error
type TestRegistrationRunner func(context.Context, model.Principal, sp.TestRegistration, func(*Operation, store.SessionScope, *Access) error) error
type GrantRunner func(context.Context, []byte, func(*Access) error) error
type TaskRunner func(context.Context, model.Principal, string, string, func(*Operation, store.SessionScope, *TaskAccess, func(string) (*Access, error)) error) error
type CredentialRunner func(context.Context, model.Principal, func(*Operation, store.SessionScope) error) error
type TerminalRegistrationRunner func(context.Context, model.Principal, string, string, func(*Operation, store.SessionScope, *TaskAccess) error) error
type AuthorizationRunner func(context.Context, *Operation, store.SessionScope, model.Principal, Authority) error
type BotRunner func(context.Context, model.Principal, string, string, func(model.Bot) error, func(model.Bot, *Access) error, func(*Operation, store.SessionScope, model.Bot, *Access, func(model.Principal) error) error) error

// Execution binds the shared engine to its application's transaction runner.
// Neither the transaction scope nor a single Operation is retained here.
type Execution struct {
	*Engine
	browserRun              BrowserRunner
	controllerRun           ControllerRunner
	archiveRun              ArchiveRunner
	archivePreflightRun     ArchivePreflightRunner
	terminalRun             TerminalRunner
	taskRegistrationRun     TaskRegistrationRunner
	testRegistrationRun     TestRegistrationRunner
	grantRun                GrantRunner
	taskRun                 TaskRunner
	credentialRun           CredentialRunner
	terminalRegistrationRun TerminalRegistrationRunner
	authorizationRun        AuthorizationRunner
	botRun                  BotRunner
}

func NewExecution(engine *Engine, browser BrowserRunner, controller ControllerRunner, archive ArchiveRunner, terminal TerminalRunner, taskRegistration TaskRegistrationRunner, testRegistration TestRegistrationRunner, grant GrantRunner, task TaskRunner, credential CredentialRunner, bot BotRunner, terminalRegistration TerminalRegistrationRunner, authorization AuthorizationRunner) *Execution {
	return &Execution{Engine: engine, browserRun: browser, controllerRun: controller, archiveRun: archive, terminalRun: terminal, taskRegistrationRun: taskRegistration, testRegistrationRun: testRegistration, grantRun: grant, taskRun: task, credentialRun: credential, botRun: bot, terminalRegistrationRun: terminalRegistration, authorizationRun: authorization}
}

// BeginOperation admits work without taking a live-cell lock. Database locks
// must be acquired in their established order before the first cell is loaded.
func (s *Engine) BeginOperation() (*Operation, error) {
	s.admissionMutex.Lock()
	defer s.admissionMutex.Unlock()
	if s.closing {
		return nil, fault("service_unavailable", "Session work is stopping.")
	}
	if s.activeOperations == 0 {
		s.idle = make(chan struct{})
	}
	if s.stopping == nil {
		s.stopping = make(chan struct{})
	}
	s.activeOperations++
	return &Operation{engine: s, cells: make(map[string]*liveCell), live: make(map[string]*liveSession)}, nil
}

// Finish publishes only a confirmed commit, even if cleanup also returned an
// error. It releases every cell before invoking notifications.
func (op *Operation) Finish(outcome store.TransactionOutcome) {
	if op.finished {
		return
	}
	op.finished = true
	if op.engine != nil {
		defer op.engine.endOperation()
	}
	for id, cell := range op.cells {
		if outcome == store.TransactionCommitted {
			cell.value = op.live[id]
		}
		cell.mu.Unlock()
	}
	if outcome == store.TransactionCommitted {
		for _, notify := range op.committed {
			notify()
		}
	} else {
		for _, discard := range op.discarded {
			discard()
		}
	}
}

func (op *Operation) onDiscard(discard func()) { op.discarded = append(op.discarded, discard) }

// Close discards drafts on callback failure, cancellation, or panic.
func (op *Operation) Close() { op.Finish(store.TransactionUnknown) }

// Stopping is closed when the engine stops accepting work.
func (op *Operation) Stopping() <-chan struct{} { return op.engine.stopping }

func (s *Engine) endOperation() {
	s.admissionMutex.Lock()
	defer s.admissionMutex.Unlock()
	s.activeOperations--
	if s.activeOperations == 0 {
		close(s.idle)
	}
}

// CancelWork signals existing operations without preventing already-admitted
// transport handlers from completing their disconnect transactions.
func (s *Engine) CancelWork() {
	s.admissionMutex.Lock()
	defer s.admissionMutex.Unlock()
	s.cancelWorkLocked()
}

func (s *Engine) cancelWorkLocked() {
	if s.stopping == nil {
		s.stopping = make(chan struct{})
	}
	if !s.workCanceled {
		s.workCanceled = true
		close(s.stopping)
	}
}

// Stop closes admission and waits for admitted operations and their hooks.
func (s *Engine) Stop(ctx context.Context) error {
	s.admissionMutex.Lock()
	if !s.closing {
		s.closing = true
		s.cancelWorkLocked()
	}
	if s.activeOperations == 0 {
		s.admissionMutex.Unlock()
		return nil
	}
	idle := s.idle
	s.admissionMutex.Unlock()
	select {
	case <-idle:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
