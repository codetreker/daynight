// Package mcptransfer owns private transfer admission, accounting, and cleanup.
package mcptransfer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

const (
	SweepInterval   = 10 * time.Minute
	SweepLimit      = 100
	IdleLifetime    = transfer.IdleLifetime
	MaximumLifetime = transfer.MaximumLifetime
	Retention       = transfer.Retention
)

type Actor = transfer.Actor
type Binding = transfer.Binding

var (
	ErrConflict = transfer.ErrConflict
	ErrCapacity = transfer.ErrCapacity
	ErrState    = transfer.ErrState
)

type Lifecycle struct {
	db                   store.PrivateTransferWriter
	files                filestorage.Storage
	private              filestorage.TransferStorage
	logger               *slog.Logger
	budget, reservedFree int64
	ioSlots              chan struct{}
	mu                   sync.Mutex
	stopping             bool
	active               map[string]map[*Permit]struct{}
	wg                   sync.WaitGroup
	stop                 context.CancelFunc
	done                 chan struct{}
	ctx                  context.Context
	cancel               context.CancelFunc
	drained              chan struct{}
}

func New(db store.PrivateTransferWriter, files filestorage.Storage, private filestorage.TransferStorage, budget, reservedFree int64) (*Lifecycle, error) {
	if db == nil || files == nil || private == nil || budget <= 0 || reservedFree < 0 {
		return nil, errors.New("private transfer dependencies and capacity are required")
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Lifecycle{db: db, files: files, private: private, logger: slog.Default(), budget: budget, reservedFree: reservedFree, ioSlots: make(chan struct{}, 4), active: make(map[string]map[*Permit]struct{}), ctx: ctx, cancel: cancel}, nil
}

// SetLogger configures diagnostics before the lifecycle is started or used.
func (s *Lifecycle) SetLogger(logger *slog.Logger) {
	if logger != nil {
		s.logger = logger
	}
}

func committed(c store.Completion, err error) error {
	if err != nil {
		return err
	}
	if c.Outcome != store.TransactionCommitted {
		return &store.TransactionError{Phase: "completion", Outcome: c.Outcome, Cause: errors.New("private transfer transaction did not commit")}
	}
	return nil
}
func (s *Lifecycle) transaction(ctx context.Context, fn func(store.PrivateTransferDAO) error) error {
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		return errors.New("private transfer lifecycle stopped")
	}
	s.wg.Add(1)
	s.mu.Unlock()
	defer s.wg.Done()
	c, err := s.db.WritePrivateTransfer(ctx, fn)
	return committed(c, err)
}
func authorize(ctx context.Context, d store.PrivateTransferDAO, a transfer.Actor, r model.PrivateTransfer) error {
	if !transfer.OwnedBy(r, a) {
		return transfer.ErrConflict
	}
	return projectcore.LookupError(d.Authorize(ctx, a.Principal, a.AuthorityKind, a.AuthorityID, r.ProjectID, r.TaskID))
}

// OpenRecord commits the namespace owner before any private object can exist.
// A duplicate ID only returns the matching record and never allocates a new slot.
func (s *Lifecycle) OpenRecord(ctx context.Context, a transfer.Actor, b transfer.Binding) (model.PrivateTransfer, bool, error) {
	if err := transfer.ValidateActor(a); err != nil {
		return model.PrivateTransfer{}, false, err
	}
	input, err := transfer.NewRecord(a, b, time.Now().UTC())
	if err != nil {
		return model.PrivateTransfer{}, false, err
	}
	params := input.Binding

	var result model.PrivateTransfer
	var created bool
	err = s.transaction(ctx, func(d store.PrivateTransferDAO) error {
		existing, lookupErr := d.Get(ctx, b.ID)
		if lookupErr == nil {
			if !transfer.SameBinding(existing, a, b, params) {
				return transfer.ErrConflict
			}
			if err := authorize(ctx, d, a, existing); err != nil {
				return err
			}
			result = existing
			return nil
		}
		if !errors.Is(lookupErr, model.ErrNotFound) {
			return lookupErr
		}
		if err := d.Authorize(ctx, a.Principal, a.AuthorityKind, a.AuthorityID, b.ProjectID, b.TaskID); err != nil {
			return projectcore.LookupError(err)
		}
		var e error
		result, created, e = transfer.Create(ctx, d, input)
		if e != nil {
			return e
		}
		if !transfer.SameBinding(result, a, b, params) {
			return transfer.ErrConflict
		}
		return nil
	})
	if err != nil {
		return model.PrivateTransfer{}, false, err
	}
	return result, created, err
}

// LookupBound revalidates the current credential and task permission on each call.
func (s *Lifecycle) LookupBound(ctx context.Context, a transfer.Actor, id string) (model.PrivateTransfer, error) {
	if err := transfer.ValidateActor(a); err != nil {
		return model.PrivateTransfer{}, err
	}
	if !transfer.Canonical(id) {
		return model.PrivateTransfer{}, transfer.ErrConflict
	}
	var r model.PrivateTransfer
	err := s.transaction(ctx, func(d store.PrivateTransferDAO) error {
		var e error
		r, e = d.Get(ctx, id)
		if e != nil {
			return projectcore.LookupError(e)
		}
		return authorize(ctx, d, a, r)
	})
	if err != nil {
		return model.PrivateTransfer{}, err
	}
	return r, err
}

// Authorize checks the current credential, stable authority and task access
// without allocating a transfer or an I/O slot.
func (s *Lifecycle) Authorize(ctx context.Context, a Actor, projectID, taskID string) error {
	if err := transfer.ValidateActor(a); err != nil {
		return err
	}
	if !transfer.Canonical(projectID) || !transfer.Canonical(taskID) {
		return ErrConflict
	}
	return s.transaction(ctx, func(d store.PrivateTransferDAO) error {
		return projectcore.LookupError(d.Authorize(ctx, a.Principal, a.AuthorityKind, a.AuthorityID, projectID, taskID))
	})
}

// Touch renews an admitted transfer without acquiring an I/O slot. Terminal
// records are returned unchanged; expired records cannot be revived.
func (s *Lifecycle) Touch(ctx context.Context, a Actor, id string) (model.PrivateTransfer, error) {
	if err := transfer.ValidateActor(a); err != nil {
		return model.PrivateTransfer{}, err
	}
	if !transfer.Canonical(id) {
		return model.PrivateTransfer{}, ErrConflict
	}
	var r model.PrivateTransfer
	err := s.transaction(ctx, func(d store.PrivateTransferDAO) error {
		var e error
		r, e = d.Get(ctx, id)
		if e != nil {
			return e
		}
		if e = authorize(ctx, d, a, r); e != nil {
			return e
		}
		if r.State == "cleanup_pending" || r.State == "closed" || r.State == "failed" {
			return nil
		}
		now := time.Now().UTC()
		if !transfer.Live(r, now) || !transfer.ContentState(r.State) {
			return ErrState
		}
		r.UpdatedAt = now
		r = transfer.Renew(r, now)
		r, e = transfer.Update(ctx, d, r, r.Version)
		return e
	})
	if err != nil {
		return model.PrivateTransfer{}, err
	}
	return r, nil
}

// Reserve conservatively accounts for the complete outstanding ledger against
// sampled free space as well as the configured shared budget.
func (s *Lifecycle) Reserve(ctx context.Context, a transfer.Actor, id string, additional int64) (model.PrivateTransfer, error) {
	if err := transfer.ValidateActor(a); err != nil {
		return model.PrivateTransfer{}, err
	}
	if additional < 0 || !transfer.Canonical(id) {
		return model.PrivateTransfer{}, transfer.ErrConflict
	}
	var r model.PrivateTransfer
	err := s.transaction(ctx, func(d store.PrivateTransferDAO) error {
		var e error
		r, e = d.Get(ctx, id)
		if e != nil {
			return projectcore.LookupError(e)
		}
		if e = authorize(ctx, d, a, r); e != nil {
			return e
		}
		if !transfer.Live(r, time.Now()) || !transfer.ContentState(r.State) {
			return transfer.ErrState
		}
		if e = d.LockLedger(ctx); e != nil {
			return e
		}
		// Sample while the ledger is locked so a concurrent publication cannot
		// consume an old outstanding reservation between the two observations.
		free, e := s.private.AvailableTransferBytes(ctx)
		if e != nil {
			return e
		}
		total, e := d.OutstandingTotal(ctx)
		if e != nil {
			return e
		}
		if !transfer.CapacityAvailable(free, s.reservedFree, total, additional) {
			return transfer.ErrCapacity
		}
		r, e = transfer.Reserve(ctx, d, id, additional, s.budget)
		return e
	})
	if err != nil {
		return model.PrivateTransfer{}, err
	}
	return r, err
}

// Transition applies a versioned direction-specific state and receipt update.
// Cleanup and close have separate operations so neither can bypass the gate.
func (s *Lifecycle) Transition(ctx context.Context, a Actor, id string, version int64, state string, data json.RawMessage, leaseUntil *time.Time) (model.PrivateTransfer, error) {
	if version <= 0 {
		return model.PrivateTransfer{}, ErrState
	}
	return s.transition(ctx, a, id, version, state, data, leaseUntil, 0)
}

// TransitionPublished records a confirmed file publication and its receipt in
// one transaction. Until then its reservation remains outstanding after a crash.
func (s *Lifecycle) TransitionPublished(ctx context.Context, p *Permit, a Actor, id string, version int64, state string, data json.RawMessage, leaseUntil *time.Time, materialized int64) (model.PrivateTransfer, error) {
	if p == nil || p.owner != s || p.id != id || materialized < 0 || version <= 0 {
		return model.PrivateTransfer{}, ErrState
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return model.PrivateTransfer{}, transfer.ErrState
	}
	return s.transition(ctx, a, id, version, state, data, leaseUntil, materialized)
}

// PublishDownload atomically publishes a preparing snapshot against the locked
// current row, so concurrent status renewal cannot invalidate its receipt.
func (s *Lifecycle) PublishDownload(ctx context.Context, p *Permit, a Actor, id string, data json.RawMessage, materialized int64) (model.PrivateTransfer, error) {
	if p == nil || p.owner != s || p.id != id || p.actor != a || materialized < 0 {
		return model.PrivateTransfer{}, ErrState
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return model.PrivateTransfer{}, ErrState
	}
	return s.transition(ctx, a, id, 0, "readable", data, nil, materialized)
}

func (s *Lifecycle) transition(ctx context.Context, a Actor, id string, version int64, state string, data json.RawMessage, leaseUntil *time.Time, materialized int64) (model.PrivateTransfer, error) {
	if err := transfer.ValidateActor(a); err != nil {
		return model.PrivateTransfer{}, err
	}
	parsed, err := transfer.NormalizeJSON(data)
	if err != nil {
		return model.PrivateTransfer{}, transfer.ErrConflict
	}
	var r model.PrivateTransfer
	err = s.transaction(ctx, func(d store.PrivateTransferDAO) error {
		var e error
		r, e = d.Get(ctx, id)
		if e != nil {
			return projectcore.LookupError(e)
		}
		if e = authorize(ctx, d, a, r); e != nil {
			return e
		}
		if version == 0 {
			if r.Direction != "download" || r.State != "preparing" || state != "readable" {
				return ErrState
			}
			version = r.Version
		}
		next, e := transfer.Transition(r, version, state, parsed, leaseUntil, time.Now().UTC())
		if e != nil {
			return e
		}
		if materialized > 0 {
			r, e = transfer.ConsumeReservation(ctx, d, id, materialized, version)
			if e != nil {
				return e
			}
			version = r.Version
			next.ReservedBytes, next.OutstandingBytes, next.Version = r.ReservedBytes, r.OutstandingBytes, r.Version
		}
		r = next
		r, e = transfer.Update(ctx, d, r, version)
		return e
	})
	if err != nil {
		return model.PrivateTransfer{}, err
	}
	return r, err
}

// FinishCommit records a verified result for the original operation, including
// after its credential expires or cleanup is requested. It cannot reopen a
// namespace once cleanup is pending. A zero version observes the locked row;
// the operation ID still fences a late result against another commit. This is
// an internal receipt write; exposing its result requires current admission.
func (s *Lifecycle) FinishCommit(ctx context.Context, p *Permit, a transfer.Actor, id string, version int64, state string, data json.RawMessage) (model.PrivateTransfer, error) {
	if p == nil || p.owner != s || p.id != id || !transfer.FinishStateValid(state) {
		return model.PrivateTransfer{}, transfer.ErrState
	}
	if err := transfer.ValidateActor(a); err != nil {
		return model.PrivateTransfer{}, err
	}
	parsed, err := transfer.NormalizeJSON(data)
	if err != nil {
		return model.PrivateTransfer{}, transfer.ErrConflict
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return model.PrivateTransfer{}, transfer.ErrState
	}
	var result model.PrivateTransfer
	completionCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	versionForDecision := version
	c, txErr := s.db.WritePrivateTransfer(completionCtx, func(d store.PrivateTransferDAO) error {
		var e error
		result, e = d.Get(completionCtx, id)
		if e != nil {
			return e
		}
		// The original admitted operation owns this completion even if its
		// credential expires while the external write is finishing.
		if a != p.actor || !transfer.OwnedBy(result, a) {
			return transfer.ErrConflict
		}
		version = result.Version
		next, pending, e := transfer.FinishCommit(result, versionForDecision, state, parsed)
		if e != nil {
			return e
		}
		if pending {
			result, e = transfer.UpdatePending(completionCtx, d, next, version)
		} else {
			result, e = transfer.Update(completionCtx, d, next, version)
		}

		return e
	})
	err = committed(c, txErr)
	if err != nil {
		return model.PrivateTransfer{}, err
	}
	return result, nil
}

func (s *Lifecycle) CompletePending(ctx context.Context, p *Permit, a transfer.Actor, id string, version int64, state string, data json.RawMessage) (model.PrivateTransfer, error) {
	return s.FinishCommit(ctx, p, a, id, version, state, data)
}

// Permit holds the namespace gate and one instance I/O slot. The operation must
// use Context and close every file handle before releasing the permit.
type Permit struct {
	Context context.Context
	cancel  context.CancelFunc
	gate    io.Closer
	owner   *Lifecycle
	id      string
	actor   transfer.Actor
	once    sync.Once
	err     error
	mu      sync.Mutex
	closed  bool
}

func (p *Permit) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.once.Do(func() {
		p.closed = true
		p.cancel()
		p.err = p.gate.Close()
		p.owner.mu.Lock()
		delete(p.owner.active[p.id], p)
		if len(p.owner.active[p.id]) == 0 {
			delete(p.owner.active, p.id)
		}
		p.owner.mu.Unlock()
		<-p.owner.ioSlots
		p.owner.wg.Done()
	})
	return p.err
}
func (s *Lifecycle) cancelTransfer(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for p := range s.active[id] {
		p.cancel()
	}
}

// AcquirePermit rechecks durable admission after obtaining the independent
// cross-process gate. A lost database connection cannot release this permit.
func (s *Lifecycle) AcquirePermit(ctx context.Context, a transfer.Actor, id string) (*Permit, error) {
	if err := transfer.ValidateActor(a); err != nil {
		return nil, err
	}
	if !transfer.Canonical(id) {
		return nil, transfer.ErrConflict
	}
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		return nil, errors.New("private transfer lifecycle stopped")
	}
	s.wg.Add(1)
	s.mu.Unlock()
	select {
	case s.ioSlots <- struct{}{}:
	case <-ctx.Done():
		s.wg.Done()
		return nil, ctx.Err()
	case <-s.ctx.Done():
		s.wg.Done()
		return nil, errors.New("private transfer lifecycle stopped")
	}
	opCtx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(s.ctx, cancel)
	defer stop()
	gate, err := s.files.AcquireGate(opCtx, filestorage.PrivateGate, id)
	if err != nil {
		cancel()
		<-s.ioSlots
		s.wg.Done()
		return nil, err
	}
	p := &Permit{Context: opCtx, cancel: cancel, gate: gate, owner: s, id: id, actor: a}
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		_ = gate.Close()
		cancel()
		<-s.ioSlots
		s.wg.Done()
		return nil, errors.New("private transfer lifecycle stopped")
	}
	if s.active[id] == nil {
		s.active[id] = make(map[*Permit]struct{})
	}
	s.active[id][p] = struct{}{}
	s.mu.Unlock()
	err = s.transaction(opCtx, func(d store.PrivateTransferDAO) error {
		r, err := d.Get(opCtx, id)
		if err != nil {
			return projectcore.LookupError(err)
		}
		if err = authorize(opCtx, d, a, r); err != nil {
			return err
		}
		now := time.Now().UTC()
		if !transfer.Live(r, now) || !transfer.ContentState(r.State) {
			return transfer.ErrState
		}
		r = transfer.Renew(r, now)
		_, err = transfer.Update(opCtx, d, r, r.Version)
		return err
	})
	if err != nil {
		_ = p.Close()
		return nil, err
	}
	return p, nil
}

// RequestCleanup persists the barrier before cancelling locally active work.
func (s *Lifecycle) RequestCleanup(ctx context.Context, a transfer.Actor, id string) (model.PrivateTransfer, error) {
	if err := transfer.ValidateActor(a); err != nil {
		return model.PrivateTransfer{}, err
	}
	var r model.PrivateTransfer
	err := s.transaction(ctx, func(d store.PrivateTransferDAO) error {
		var e error
		r, e = d.Get(ctx, id)
		if e != nil {
			return projectcore.LookupError(e)
		}
		if e = authorize(ctx, d, a, r); e != nil {
			return e
		}
		for _, next := range transfer.CleanupSteps(r, time.Now().UTC(), false) {
			// Each mutation uses the version returned by the preceding write.
			next.Version = r.Version
			r, e = transfer.Update(ctx, d, next, r.Version)
			if e != nil {
				return e
			}
		}

		return e
	})
	if err == nil && transfer.PendingCleanup(r) {
		s.cancelTransfer(id)
	}
	if err != nil {
		return model.PrivateTransfer{}, err
	}
	return r, err
}

// Maintain processes a bounded batch. Failed removal keeps the durable barrier,
// reservation and slot for a later sweep; the namespace gate protects late I/O.
func (s *Lifecycle) Maintain(ctx context.Context) error {
	now := time.Now().UTC()
	sweepID := uuid.NewString()
	var due []model.PrivateTransfer
	err := s.transaction(ctx, func(d store.PrivateTransferDAO) error {
		var e error
		due, e = transfer.Due(ctx, d, now, SweepLimit)
		return e
	})
	if err != nil {
		return err
	}
	var failures []error
	for _, candidate := range due {
		if err := ctx.Err(); err != nil {
			return errors.Join(append(failures, err)...)
		}
		r, err := s.markDue(ctx, candidate.ID, now)
		if err != nil {
			failures = append(failures, err)
			continue
		}
		if !transfer.PendingCleanup(r) {
			continue
		}
		s.cancelTransfer(r.ID)
		// One live writer must not monopolize an entire sweep.
		gateCtx, cancel := context.WithTimeout(ctx, time.Second)
		select {
		case s.ioSlots <- struct{}{}:
		case <-gateCtx.Done():
			failures = append(failures, gateCtx.Err())
			cancel()
			continue
		}
		gate, err := s.files.AcquireGate(gateCtx, filestorage.PrivateGate, r.ID)
		cancel()
		if err != nil {
			s.logger.WarnContext(ctx, "private transfer cleanup deferred", "component", "mcptransfer", "sweep_id", sweepID, "transfer_id", r.ID, "phase", "gate")
			<-s.ioSlots
			failures = append(failures, err)
			continue
		}
		namespace, e := filestorage.NewTransferNamespace(r.ID)
		if e == nil {
			e = s.private.DeleteTransferNamespace(ctx, namespace)
		}
		if e == nil {
			e = s.transaction(ctx, func(d store.PrivateTransferDAO) error {
				current, err := d.Get(ctx, r.ID)
				if err != nil {
					return err
				}
				if !transfer.PendingCleanup(current) {
					return transfer.ErrState
				}
				_, err = transfer.Close(ctx, d, current.ID, current.Version, time.Now().UTC().Add(transfer.Retention))
				return err
			})
		}
		e = errors.Join(e, gate.Close())
		<-s.ioSlots
		if e != nil {
			s.logger.WarnContext(ctx, "private transfer cleanup deferred", "component", "mcptransfer", "sweep_id", sweepID, "transfer_id", r.ID, "phase", "cleanup")
			failures = append(failures, e)
		}
	}
	err = s.transaction(ctx, func(d store.PrivateTransferDAO) error { _, e := transfer.Prune(ctx, d, now, SweepLimit); return e })
	if err != nil {
		failures = append(failures, err)
	}
	var stats store.PrivateTransferStats
	if e := s.transaction(ctx, func(d store.PrivateTransferDAO) error { var err error; stats, err = d.Stats(ctx); return err }); e != nil {
		failures = append(failures, e)
	} else {
		s.logger.InfoContext(ctx, "private transfer maintenance", "component", "mcptransfer", "sweep_id", sweepID, "temp_reserved_bytes", stats.ReservedBytes, "temp_budget_bytes", s.budget, "cleanup_backlog", stats.CleanupPending, "cleanup_oldest", stats.OldestPendingCreatedAt)
	}
	return errors.Join(failures...)
}
func (s *Lifecycle) markDue(ctx context.Context, id string, now time.Time) (model.PrivateTransfer, error) {
	var r model.PrivateTransfer
	err := s.transaction(ctx, func(d store.PrivateTransferDAO) error {
		var e error
		r, e = d.Get(ctx, id)
		if e != nil {
			return e
		}
		for _, next := range transfer.CleanupSteps(r, now, true) {
			next.Version = r.Version
			r, e = transfer.Update(ctx, d, next, r.Version)
			if e != nil {
				return e
			}
		}

		return e
	})
	return r, err
}

// Start owns one startup sweep and a periodic bounded maintainer. report must
// only emit safe error categories, never submitted content or credentials.
func (s *Lifecycle) Start(report func(error)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopping || s.done != nil {
		return errors.New("private transfer maintainer already started or stopped")
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.stop = cancel
	s.done = make(chan struct{})
	done := s.done
	go func() {
		defer close(done)
		run := func() {
			if err := s.Maintain(ctx); err != nil && ctx.Err() == nil && report != nil {
				report(err)
			}
		}
		run()
		ticker := time.NewTicker(SweepInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				run()
			}
		}
	}()
	return nil
}

// Close cancels operations and joins both permits and the maintainer before the
// borrowed store and files can be closed. A timed-out call may be retried.
func (s *Lifecycle) Close(ctx context.Context) error {
	s.mu.Lock()
	s.stopping = true
	s.cancel()
	if s.stop != nil {
		s.stop()
	}
	for _, group := range s.active {
		for p := range group {
			p.cancel()
		}
	}
	done := s.done
	if s.drained == nil {
		s.drained = make(chan struct{})
		drained := s.drained
		go func() { s.wg.Wait(); close(drained) }()
	}
	drained := s.drained
	s.mu.Unlock()
	if done != nil {
		select {
		case <-done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	select {
	case <-drained:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
