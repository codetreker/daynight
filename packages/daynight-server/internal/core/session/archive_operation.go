package session

import (
	"context"
	"errors"
	"io"
	"sync"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// ArchiveMode identifies the protocol and authorization needed before archive I/O.
type ArchiveMode uint8

const (
	ArchiveV1Read ArchiveMode = iota + 1
	ArchiveV1Upload
	ArchiveV2Read
	ArchiveV2Upload
)

// ArchiveOperation owns one instance and one original-owner permit until Close.
// A caller must keep it open until it has finished using all large input and output.
type ArchiveOperation struct {
	historyWriter            *ActiveHistoryWriter
	finalizeMigration        bool
	mu                       sync.Mutex
	execution                *Execution
	principal                model.Principal
	project, task, id, owner string
	mode                     ArchiveMode
	permit                   io.Closer
	closed                   bool
	closeErr                 error
	committed                bool
}

// RetainedArchive owns its exact original bytes and the permit protecting them.
type RetainedArchive struct {
	Data      []byte
	operation *ArchiveOperation
	closeFn   func() error
	closeOnce sync.Once
	closeErr  error
}

func (r *RetainedArchive) Close() error {
	r.closeOnce.Do(func() {
		if r.closeFn != nil {
			r.closeErr = r.closeFn()
		}
		r.closeErr = errors.Join(r.closeErr, r.operation.Close())
	})
	return r.closeErr
}

// BeginArchive verifies access in a short database scope before taking permits.
// The subsequent operation rechecks authorization, owner, and all business fences.
// ArchivePreflightReservation bounds work before the short metadata scope.
// A protocol may reserve it before authentication, which can itself need the pool.
type ArchivePreflightReservation struct {
	mu              sync.Mutex
	engine          *Engine
	claimed, closed bool
}

func (s *Execution) TryReserveArchivePreflight() (*ArchivePreflightReservation, error) {
	select {
	case s.archivePreflightSlots <- struct{}{}:
	default:
		return nil, archiveBusy()
	}
	if len(s.archiveSlots) != 0 {
		<-s.archivePreflightSlots
		return nil, archiveBusy()
	}
	return &ArchivePreflightReservation{engine: s.Engine}, nil
}

func (r *ArchivePreflightReservation) claim(engine *Engine) error {
	if r == nil {
		return errors.New("missing archive preflight reservation")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.engine != engine || r.closed || r.claimed {
		return errors.New("invalid archive preflight reservation")
	}
	r.claimed = true
	return nil
}

func (r *ArchivePreflightReservation) release() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.closed {
		r.closed = true
		<-r.engine.archivePreflightSlots
	}
}

// Close releases an unused reservation. Once claimed, BeginArchiveReserved owns it.
func (r *ArchivePreflightReservation) Close() error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.claimed && !r.closed {
		r.closed = true
		<-r.engine.archivePreflightSlots
	}
	return nil
}

func (s *Execution) BeginArchive(ctx context.Context, p model.Principal, project, taskID, id string, mode ArchiveMode) (*ArchiveOperation, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	reservation, err := s.TryReserveArchivePreflight()
	if err != nil {
		return nil, err
	}
	return s.BeginArchiveReserved(ctx, p, project, taskID, id, mode, reservation)
}

func (s *Execution) BeginArchiveReserved(ctx context.Context, p model.Principal, project, taskID, id string, mode ArchiveMode, reservation *ArchivePreflightReservation) (*ArchiveOperation, error) {
	if err := reservation.claim(s.Engine); err != nil {
		return nil, err
	}
	defer reservation.release()
	if mode < ArchiveV1Read || mode > ArchiveV2Upload {
		return nil, errors.New("invalid archive mode")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if s.archivePreflightRun == nil {
		return nil, errors.New("archive preflight unavailable")
	}
	owner, err := s.archivePreflightRun(ctx, p, project, taskID, id, mode)
	if err != nil {
		return nil, err
	}
	select {
	case s.archiveSlots <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
		return nil, archiveBusy()
	}
	admitted := false
	defer func() {
		if !admitted {
			s.releaseArchiveSlot()
		}
	}()
	owner, err = model.CanonicalID(owner)
	if err != nil {
		return nil, err
	}
	if s.files == nil {
		return nil, errors.New("archive residency gate unavailable")
	}
	permit, err := s.files.TryAcquireResidency(ctx, "session/archive/owner/"+owner)
	if err != nil {
		if onlyArchiveGateBusy(err) {
			return nil, errors.Join(archiveBusy(), err)
		}
		return nil, err
	}
	admitted = true
	return &ArchiveOperation{execution: s, principal: p, project: project, task: taskID, id: id, owner: owner, mode: mode, permit: permit}, nil
}

func archiveBusy() error { return fault("resource_busy", "Session archive capacity is unavailable.") }

func (op *ArchiveOperation) Close() error {
	if op == nil {
		return nil
	}
	op.mu.Lock()
	defer op.mu.Unlock()
	if !op.closed {
		op.closed = true
		op.closeErr = archiveCleanupFailure(nil, op.permit.Close())
		if op.closeErr != nil && op.committed {
			op.closeErr = &store.TransactionError{Phase: "cleanup", Cause: op.closeErr, Outcome: store.TransactionCommitted, CommitAttempted: true, CleanupFailed: true}
		}
		op.execution.releaseArchiveSlot()
	}
	return op.closeErr
}

func (op *ArchiveOperation) check(mode ArchiveMode) error {
	if op == nil || op.closed || op.mode != mode {
		return errors.New("invalid or closed archive operation")
	}
	return nil
}

func (op *ArchiveOperation) PutArchive(ctx context.Context, data []byte) (sp.ArchiveStatus, error) {
	op.mu.Lock()
	defer op.mu.Unlock()
	if err := op.check(ArchiveV1Upload); err != nil {
		return sp.ArchiveStatus{}, err
	}
	out, err := op.execution.putArchive(ctx, op, data)
	op.markCommit(err)
	return out, err
}

func (op *ArchiveOperation) PutTerminalArchive(ctx context.Context, data []byte) (v2.Message, error) {
	op.mu.Lock()
	defer op.mu.Unlock()
	if err := op.check(ArchiveV2Upload); err != nil {
		return v2.Message{}, err
	}
	out, err := op.execution.putTerminalArchive(ctx, op, data)
	op.markCommit(err)
	return out, err
}

// SetArchivePreflight binds archive admission to the application's short metadata scope.
func (s *Execution) SetArchivePreflight(run ArchivePreflightRunner) { s.archivePreflightRun = run }

// ArchivePreflight selects the trusted owner without taking Session or Task row locks.
// Its result is only a permit key: the actual operation repeats all access checks.
func (op *Operation) ArchivePreflight(ctx context.Context, scope store.SessionScope, p model.Principal, project, taskID, id string, mode ArchiveMode) (string, error) {
	dao := scope.SessionDAO()
	taskRead := project != "" && taskID != "" && mode == ArchiveV1Read
	if p.Kind != model.PATCredential && p.Kind != model.SessionCredential && !(p.Kind == model.OAuthCredential && taskRead) {
		return "", denied()
	}
	if err := dao.ReadCredential(ctx, p, op.engine.now()); err != nil {
		if errors.Is(err, model.ErrNotFound) {
			return "", fault("unauthenticated", "Credential expired or was revoked.")
		}
		return "", err
	}
	if project != "" {
		if err := op.CheckProjectAccess(ctx, scope, p, project); err != nil {
			return "", err
		}
	}
	m, err := dao.ArchiveMetadata(ctx, id)
	if err != nil {
		return "", err
	}
	v2Mode := mode == ArchiveV2Read || mode == ArchiveV2Upload
	upload := mode == ArchiveV1Upload || mode == ArchiveV2Upload
	if (v2Mode && m.Backend != "herdr") || (!v2Mode && m.Backend != "web") || m.Project != project || m.Task != taskID || (project == "") != m.Test {
		return "", conflict()
	}
	if project != "" && (!m.TaskExists || !m.ProjectLive || (m.TaskDeleted && !upload)) {
		return "", fault("not_found", "Session was not found.")
	}
	if !m.BotValid {
		return "", fault("resource_conflict", "Bot is deleted.")
	}
	if project == "" {
		if p.UserID != m.Owner {
			return "", denied()
		}
		if m.Parent != "" {
			parent := model.Principal{Kind: model.PATCredential, UserID: m.Owner, CredentialID: m.Parent}
			if err = dao.ReadCredential(ctx, parent, op.engine.now()); err != nil {
				if errors.Is(err, model.ErrNotFound) {
					return "", fault("unauthenticated", "Credential expired or was revoked.")
				}
				return "", err
			}
		}
	}
	if (upload || m.TaskDeleted) && (p.Kind != model.PATCredential || p.UserID != m.Owner) {
		return "", denied()
	}
	return m.Owner, nil
}

func (s *Engine) releaseArchiveSlot() {
	<-s.archiveSlots
}

func (op *ArchiveOperation) markCommit(err error) {
	if err == nil {
		op.committed = true
		return
	}
	var tx *store.TransactionError
	if errors.As(err, &tx) && tx.Outcome == store.TransactionCommitted {
		op.committed = true
	}
}

func onlyArchiveGateBusy(err error) bool {
	if err == filestorage.ErrGateBusy {
		return true
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		children := joined.Unwrap()
		return len(children) == 1 && onlyArchiveGateBusy(children[0])
	}
	if next := errors.Unwrap(err); next != nil {
		return onlyArchiveGateBusy(next)
	}
	return false
}

// archiveCleanupFailure preserves both causes and makes unfinished cleanup
// distinguishable from a business rejection at the transport boundary.
func archiveCleanupFailure(cause, closeErr error) error {
	if closeErr == nil {
		return cause
	}
	return &model.Fault{Code: "cleanup_unknown", Message: "Archive cleanup failed.", Cause: errors.Join(cause, closeErr)}
}
