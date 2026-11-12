// Package credentialusage drives bounded sampling of successful credential use.
package credentialusage

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"sync"
	"time"

	usage "github.com/codetreker/daynight/packages/daynight-server/internal/core/credentialusage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
)

const (
	operationTimeout = 2 * time.Second
	checkInterval    = time.Second
	lagLimit         = 60 * time.Second
)

var (
	ErrDependency        = errors.New("credential usage recorder requires a writer and logger")
	ErrNotStarted        = errors.New("credential usage recorder is not started")
	ErrAlreadyStarted    = errors.New("credential usage recorder already started")
	ErrMissingCollector  = errors.New("credential usage observation collector is required")
	ErrInvalidCompletion = errors.New("credential usage writer returned invalid completion")
	ErrUnconfirmed       = errors.New("credential usage write was not confirmed")
)

type sourceKey struct{}

// WithSource identifies the trusted successful-use boundary for Record.
func WithSource(ctx context.Context, source usage.Source) context.Context {
	return context.WithValue(ctx, sourceKey{}, source)
}

// DrainError reports a completed drain with historical recording failures.
// A timeout waiting for the producers is returned separately and is not drained.
type DrainError struct {
	// Unpersisted counts snapshots whose persistence was not confirmed. An
	// unknown transaction outcome may nevertheless have committed.
	Unpersisted uint64
	Cause       error
}

func (e *DrainError) Error() string {
	return fmt.Sprintf("credential usage drain completed with %d unconfirmed samples", e.Unpersisted)
}
func (e *DrainError) Unwrap() error { return e.Cause }
func (e *DrainError) Drained() bool { return true }

// Snapshot describes recorder state and bounded sampler diagnostics.
type Snapshot struct {
	State string
	usage.Snapshot
}

// Recorder owns one database worker and one independent diagnostic consumer.
// Constructing it does not start either goroutine.
type Recorder struct {
	writer         store.CredentialUsageWriter
	logger         *slog.Logger
	clock          func() time.Time
	sampler        *usage.Sampler
	mu             sync.Mutex
	started        bool
	workCtx        context.Context
	cancel         context.CancelFunc
	workerDone     chan struct{}
	diagnosticDone chan struct{}
	wake           chan struct{}
	diagnosticWake chan struct{}
	firstCause     error
	abandonedCause error
}

func New(writer store.CredentialUsageWriter, logger *slog.Logger, clock func() time.Time) (*Recorder, error) {
	if missingWriter(writer) || logger == nil {
		return nil, ErrDependency
	}
	if clock == nil {
		clock = time.Now
	}
	return &Recorder{writer: writer, logger: logger, clock: clock, sampler: usage.New(clock), workerDone: make(chan struct{}), diagnosticDone: make(chan struct{}), wake: make(chan struct{}, 1), diagnosticWake: make(chan struct{}, 1)}, nil
}

func missingWriter(writer store.CredentialUsageWriter) bool {
	if writer == nil {
		return true
	}
	value := reflect.ValueOf(writer)
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return value.IsNil()
	default:
		return false
	}
}

func notify(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}

// Start starts the original work once. Its context is the application work
// context, not a request context; CancelWork explicitly cancels that work.
func (r *Recorder) Start(ctx context.Context) error {
	if ctx == nil {
		return errors.New("credential usage work context is required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.started {
		return ErrAlreadyStarted
	}
	r.workCtx, r.cancel = context.WithCancel(ctx)
	r.started = true
	go r.runWorker()
	go r.runDiagnostics()
	return nil
}

// Record only copies bounded, safe correlation and modifies the sampler. It
// never retains ctx or waits for I/O. A collector is mandatory even when the
// event is accepted, so a capacity refusal cannot become invisible.
func (r *Recorder) Record(ctx context.Context, event model.CredentialUsageEvent) (usage.Admission, error) {
	if ctx == nil {
		return 0, ErrMissingCollector
	}
	collector := usage.CollectorFrom(ctx)
	if collector == nil {
		return 0, ErrMissingCollector
	}
	source, _ := ctx.Value(sourceKey{}).(usage.Source)
	o := usage.Observation{Event: event, RequestID: requestid.From(ctx), Source: source}
	r.mu.Lock()
	if !r.started {
		r.mu.Unlock()
		return 0, ErrNotStarted
	}
	admission, err := r.sampler.Record(o)
	r.mu.Unlock()
	if err != nil {
		return admission, err
	}
	if admission == usage.Full || admission == usage.Stopped {
		cause := usage.CauseCapacity
		code := usage.CodeQueueFull
		if admission == usage.Stopped {
			cause = usage.CauseStopped
			code = usage.CodeShutdownIncomplete
		}
		fault := usage.Fault{Phase: usage.PhaseSubmit, Code: code, Cause: cause, Observation: o, OccurredAt: r.clock(), Depth: r.sampler.Snapshot().Resident}
		if err := collector.Record(fault); err != nil {
			return admission, err
		}
	} else {
		notify(r.wake)
	}
	return admission, nil
}

// CancelWork cancels the existing database work without replacing its worker.
func (r *Recorder) CancelWork() {
	r.mu.Lock()
	cancel := r.cancel
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	notify(r.wake)
}

// Drain seals admission, forces pending work due, and waits for both producers.
// A timeout leaves those same producers available for a later join.
func (r *Recorder) Drain(ctx context.Context) error {
	if ctx == nil {
		return errors.New("credential usage drain context is required")
	}
	r.mu.Lock()
	if !r.started {
		r.mu.Unlock()
		return ErrNotStarted
	}
	r.sampler.Seal()
	r.mu.Unlock()
	notify(r.wake)
	notify(r.diagnosticWake)
	select {
	case <-r.workerDone:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-r.diagnosticDone:
	case <-ctx.Done():
		return ctx.Err()
	}
	s := r.sampler.Snapshot()
	r.mu.Lock()
	cause := errors.Join(r.firstCause, r.abandonedCause)
	cancel := r.cancel
	r.mu.Unlock()
	cancel()
	if cause != nil || s.Abandoned != 0 {
		return &DrainError{Unpersisted: s.Abandoned, Cause: cause}
	}
	return nil
}

// Stop joins the same sealed work as Drain; it does not cancel it on timeout.
func (r *Recorder) Stop(ctx context.Context) error { return r.Drain(ctx) }

func (r *Recorder) Snapshot() Snapshot {
	r.mu.Lock()
	started := r.started
	r.mu.Unlock()
	s := r.sampler.Snapshot()
	state := "new"
	if started {
		state = "running"
	}
	if s.Sealed {
		state = "draining"
	}
	select {
	case <-r.diagnosticDone:
		state = "stopped"
	default:
	}
	return Snapshot{State: state, Snapshot: s}
}

func (r *Recorder) rememberCause(err error) {
	if err == nil {
		err = ErrUnconfirmed
	}
	r.mu.Lock()
	if r.firstCause == nil {
		r.firstCause = err
	}
	r.mu.Unlock()
}

func (r *Recorder) runWorker() {
	defer func() { close(r.workerDone); notify(r.diagnosticWake) }()
	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()
	for {
		batch := r.sampler.TakeDue()
		if len(batch.Observations) != 0 {
			r.writeBatch(batch)
			continue
		}
		s := r.sampler.Snapshot()
		if s.Sealed && s.Pending == 0 && s.Inflight == 0 {
			return
		}
		select {
		case <-r.wake:
		case <-ticker.C:
		}
	}
}

func (r *Recorder) writeBatch(batch usage.Batch) {
	events := make([]model.CredentialUsageEvent, len(batch.Observations))
	for i, o := range batch.Observations {
		events[i] = o.Event
		if batch.PendingAges[i] > lagLimit {
			_ = r.sampler.ReportFault(usage.Fault{Phase: usage.PhaseFlush, Code: usage.CodeLagExceeded, Observation: o, OccurredAt: r.clock(), PendingAge: batch.PendingAges[i], Depth: r.sampler.Snapshot().Resident})
			notify(r.diagnosticWake)
		}
	}
	ctx, cancel := context.WithTimeout(requestid.With(r.workCtx, batch.Observations[0].RequestID), operationTimeout)
	completion, err := r.writer.WriteCredentialUsage(ctx, events)
	ctxErr := ctx.Err()
	cancel()
	if err == nil && completion.Outcome != store.TransactionCommitted && ctxErr != nil {
		err = ctxErr
	}
	outcome := usage.Unknown
	failure := usage.Failure{Code: usage.CodeWriteOutcomeUnknown, Cause: usage.CauseUnknown}
	switch completion.Outcome {
	case store.TransactionCommitted:
		outcome = usage.Committed
	case store.TransactionNotCommitted:
		outcome = usage.NotCommitted
		failure = usage.Failure{Code: usage.CodeWriteFailed, Cause: usage.CauseDatabase}
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctxErr, context.DeadlineExceeded) {
			failure.Code, failure.Cause = usage.CodeWriteTimeout, usage.CauseTimeout
		} else if errors.Is(err, context.Canceled) || errors.Is(ctxErr, context.Canceled) {
			failure.Cause = usage.CauseCancelled
		}
	case store.TransactionUnknown:
	default:
		err = errors.Join(ErrInvalidCompletion, err)
	}
	if outcome != usage.Committed {
		r.rememberCause(err)
		_, state := store.DatabaseErrorFacts(err)
		if validSQLState(state) {
			failure.SQLState = state
		}
	}
	if outcome == usage.Committed && err != nil {
		// A confirmed commit must not be retried, but a separate cleanup error
		// remains observable and must survive the eventual drain.
		r.rememberCause(err)
		_, state := store.DatabaseErrorFacts(err)
		if !validSQLState(state) {
			state = ""
		}
		for i, o := range batch.Observations {
			_ = r.sampler.ReportFault(usage.Fault{Phase: usage.PhaseFlush, Code: usage.CodeWriteFailed, Cause: usage.CauseDatabase, Observation: o, OccurredAt: r.clock(), PendingAge: batch.PendingAges[i], Depth: r.sampler.Snapshot().Resident, SQLState: state})
		}
		notify(r.diagnosticWake)
	}
	abandonedBefore := r.sampler.Snapshot().Abandoned
	if completeErr := r.sampler.Complete(batch.ID, outcome, failure); completeErr != nil {
		// The sampler validates every completion; this indicates a programming
		// error, and retaining the batch prevents falsely claiming a drain.
		r.rememberCause(completeErr)
	}
	if outcome != usage.Committed && r.sampler.Snapshot().Abandoned > abandonedBefore {
		if err == nil {
			err = ErrUnconfirmed
		}
		r.mu.Lock()
		if r.abandonedCause == nil {
			r.abandonedCause = err
		}
		r.mu.Unlock()
	}
	if outcome != usage.Committed {
		notify(r.diagnosticWake)
	}
}

func validSQLState(s string) bool {
	if len(s) != 5 {
		return false
	}
	for i := range len(s) {
		c := s[i]
		if !(c >= 'A' && c <= 'Z' || c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}
