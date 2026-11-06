// Package mcptransfer owns private transfer admission, accounting, and cleanup.
package mcptransfer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

const (
	IdleLifetime    = time.Hour
	MaximumLifetime = 24 * time.Hour
	Retention       = 24 * time.Hour
	SweepInterval   = 10 * time.Minute
	SweepLimit      = 100
)

var (
	ErrConflict = &model.Fault{Code: "transfer_conflict", Message: "Transfer binding does not match."}
	ErrCapacity = &model.Fault{Code: "capacity_unavailable", Message: "Temporary capacity is unavailable."}
	ErrState    = &model.Fault{Code: "transfer_state_conflict", Message: "Transfer state does not permit this operation."}
)

type Actor struct {
	Principal                  model.Principal
	AuthorityKind, AuthorityID string
}

// Binding identifies the immutable owner and target, including direction-specific
// parameters. Parameters must be valid JSON and must not contain credentials.
type Binding struct {
	ID, Direction, ProjectID, TaskID, Path, ContentType string
	Parameters                                          json.RawMessage
}

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

func canonical(id string) bool {
	u, err := uuid.Parse(id)
	return err == nil && u != uuid.Nil && u.String() == id
}
func validateActor(a Actor) error {
	if err := model.RequirePrincipal(a.Principal); err != nil {
		return err
	}
	if !canonical(a.Principal.UserID) || !canonical(a.Principal.CredentialID) || !canonical(a.AuthorityID) {
		return ErrConflict
	}
	if (a.AuthorityKind == "pat" && (a.Principal.Kind != model.PATCredential || a.AuthorityID != a.Principal.CredentialID)) || (a.AuthorityKind == "oauth" && a.Principal.Kind != model.OAuthCredential) || (a.AuthorityKind != "pat" && a.AuthorityKind != "oauth") {
		return ErrConflict
	}
	return nil
}
func normalizeJSON(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	var value any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&value); err != nil {
		return nil, err
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return nil, errors.New("invalid JSON")
	}
	return json.Marshal(value)
}
func sameBinding(r model.PrivateTransfer, a Actor, b Binding, params json.RawMessage) bool {
	var stored, given any
	decode := func(raw []byte, result *any) error {
		d := json.NewDecoder(bytes.NewReader(raw))
		d.UseNumber()
		return d.Decode(result)
	}
	if decode(r.Binding, &stored) != nil || decode(params, &given) != nil {
		return false
	}
	return r.ID == b.ID && r.UserID == a.Principal.UserID && r.AuthorityKind == a.AuthorityKind && r.AuthorityID == a.AuthorityID && r.Direction == b.Direction && r.ProjectID == b.ProjectID && r.TaskID == b.TaskID && r.Path == b.Path && r.ContentType == b.ContentType && equalJSON(stored, given)
}
func equalJSON(a, b any) bool {
	switch x := a.(type) {
	case json.Number:
		y, ok := b.(json.Number)
		if !ok {
			return false
		}
		left, ok := canonicalNumber(string(x))
		if !ok {
			return false
		}
		right, ok := canonicalNumber(string(y))
		return ok && left == right
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !equalJSON(x[i], y[i]) {
				return false
			}
		}
		return true
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for k, v := range x {
			other, exists := y[k]
			if !exists || !equalJSON(v, other) {
				return false
			}
		}
		return true
	default:
		return reflect.DeepEqual(a, b)
	}
}

type numberKey struct {
	digits   string
	exponent int64
}

// Compare decimal numbers without expanding the exponent into a giant integer.
func canonicalNumber(value string) (numberKey, bool) {
	mantissa, exponentText, hasExponent := strings.Cut(strings.ToLower(value), "e")
	negative := strings.HasPrefix(mantissa, "-")
	mantissa = strings.TrimPrefix(mantissa, "-")
	whole, fraction, _ := strings.Cut(mantissa, ".")
	digits := strings.TrimLeft(whole+fraction, "0")
	if digits == "" {
		return numberKey{digits: "0"}, true
	}
	var exponent int64
	if hasExponent {
		var err error
		exponent, err = strconv.ParseInt(exponentText, 10, 64)
		if err != nil {
			return numberKey{}, false
		}
	}
	if exponent < math.MinInt64+int64(len(fraction)) {
		return numberKey{}, false
	}
	exponent -= int64(len(fraction))
	trimmed := strings.TrimRight(digits, "0")
	zeros := int64(len(digits) - len(trimmed))
	if exponent > math.MaxInt64-zeros {
		return numberKey{}, false
	}
	exponent += zeros
	if negative {
		trimmed = "-" + trimmed
	}
	return numberKey{digits: trimmed, exponent: exponent}, true
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
func authorize(ctx context.Context, d store.PrivateTransferDAO, a Actor, r model.PrivateTransfer) error {
	if r.UserID != a.Principal.UserID || r.AuthorityKind != a.AuthorityKind || r.AuthorityID != a.AuthorityID {
		return ErrConflict
	}
	return d.Authorize(ctx, a.Principal, a.AuthorityKind, a.AuthorityID, r.ProjectID, r.TaskID)
}

// OpenRecord commits the namespace owner before any private object can exist.
// A duplicate ID only returns the matching record and never allocates a new slot.
func (s *Lifecycle) OpenRecord(ctx context.Context, a Actor, b Binding) (model.PrivateTransfer, bool, error) {
	if err := validateActor(a); err != nil {
		return model.PrivateTransfer{}, false, err
	}
	if !canonical(b.ID) || !canonical(b.ProjectID) || !canonical(b.TaskID) || (b.Direction != "upload" && b.Direction != "download") {
		return model.PrivateTransfer{}, false, ErrConflict
	}
	params, err := normalizeJSON(b.Parameters)
	if err != nil {
		return model.PrivateTransfer{}, false, ErrConflict
	}
	now := time.Now().UTC()
	state := "receiving"
	if b.Direction == "download" {
		state = "preparing"
	}
	input := model.PrivateTransfer{ID: b.ID, UserID: a.Principal.UserID, AuthorityKind: a.AuthorityKind, AuthorityID: a.AuthorityID, Direction: b.Direction, ProjectID: b.ProjectID, TaskID: b.TaskID, Path: b.Path, ContentType: b.ContentType, Binding: params, Data: json.RawMessage(`{}`), State: state, CreatedAt: now, UpdatedAt: now, ExpiresAt: now.Add(IdleLifetime), HardExpiresAt: now.Add(MaximumLifetime)}
	var result model.PrivateTransfer
	var created bool
	err = s.transaction(ctx, func(d store.PrivateTransferDAO) error {
		existing, lookupErr := d.Get(ctx, b.ID)
		if lookupErr == nil {
			if !sameBinding(existing, a, b, params) {
				return ErrConflict
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
			return err
		}
		var e error
		result, created, e = d.Create(ctx, input)
		if e != nil {
			return e
		}
		if !sameBinding(result, a, b, params) {
			return ErrConflict
		}
		return nil
	})
	if err != nil {
		return model.PrivateTransfer{}, false, err
	}
	return result, created, err
}

// LookupBound revalidates the current credential and task permission on each call.
func (s *Lifecycle) LookupBound(ctx context.Context, a Actor, id string) (model.PrivateTransfer, error) {
	if err := validateActor(a); err != nil {
		return model.PrivateTransfer{}, err
	}
	if !canonical(id) {
		return model.PrivateTransfer{}, ErrConflict
	}
	var r model.PrivateTransfer
	err := s.transaction(ctx, func(d store.PrivateTransferDAO) error {
		var e error
		r, e = d.Get(ctx, id)
		if e != nil {
			return e
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
	if err := validateActor(a); err != nil {
		return err
	}
	if !canonical(projectID) || !canonical(taskID) {
		return ErrConflict
	}
	return s.transaction(ctx, func(d store.PrivateTransferDAO) error {
		return d.Authorize(ctx, a.Principal, a.AuthorityKind, a.AuthorityID, projectID, taskID)
	})
}

// Touch renews an admitted transfer without acquiring an I/O slot. Terminal
// records are returned unchanged; expired records cannot be revived.
func (s *Lifecycle) Touch(ctx context.Context, a Actor, id string) (model.PrivateTransfer, error) {
	if err := validateActor(a); err != nil {
		return model.PrivateTransfer{}, err
	}
	if !canonical(id) {
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
		if !live(r, now) || !contentState(r.State) {
			return ErrState
		}
		r.UpdatedAt = now
		r.ExpiresAt = now.Add(IdleLifetime)
		if r.ExpiresAt.After(r.HardExpiresAt) {
			r.ExpiresAt = r.HardExpiresAt
		}
		r, e = d.Update(ctx, r, r.Version)
		return e
	})
	if err != nil {
		return model.PrivateTransfer{}, err
	}
	return r, nil
}
func live(r model.PrivateTransfer, now time.Time) bool {
	return r.State != "cleanup_pending" && r.State != "closed" && now.Before(r.ExpiresAt) && now.Before(r.HardExpiresAt)
}
func contentState(state string) bool {
	return state == "receiving" || state == "preparing" || state == "readable" || state == "committing"
}

// Reserve conservatively accounts for the complete outstanding ledger against
// sampled free space as well as the configured shared budget.
func (s *Lifecycle) Reserve(ctx context.Context, a Actor, id string, additional int64) (model.PrivateTransfer, error) {
	if err := validateActor(a); err != nil {
		return model.PrivateTransfer{}, err
	}
	if additional < 0 || !canonical(id) {
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
		if !live(r, time.Now()) || !contentState(r.State) {
			return ErrState
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
		if free < s.reservedFree || total > free-s.reservedFree || additional > free-s.reservedFree-total {
			return ErrCapacity
		}
		r, e = d.Reserve(ctx, id, additional, s.budget)
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
		return model.PrivateTransfer{}, ErrState
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

func operationID(data json.RawMessage) string {
	var value struct {
		OperationID string `json:"operationId"`
	}
	if json.Unmarshal(data, &value) != nil {
		return ""
	}
	return value.OperationID
}

func (s *Lifecycle) transition(ctx context.Context, a Actor, id string, version int64, state string, data json.RawMessage, leaseUntil *time.Time, materialized int64) (model.PrivateTransfer, error) {
	if err := validateActor(a); err != nil {
		return model.PrivateTransfer{}, err
	}
	parsed, err := normalizeJSON(data)
	if err != nil {
		return model.PrivateTransfer{}, ErrConflict
	}
	var r model.PrivateTransfer
	err = s.transaction(ctx, func(d store.PrivateTransferDAO) error {
		var e error
		r, e = d.Get(ctx, id)
		if e != nil {
			return e
		}
		if e = authorize(ctx, d, a, r); e != nil {
			return e
		}
		now := time.Now().UTC()
		if version == 0 {
			if r.Direction != "download" || r.State != "preparing" || state != "readable" {
				return ErrState
			}
			version = r.Version
		}
		if !live(r, now) || r.Version != version || !allowed(r.State, state) {
			return ErrState
		}
		if state == "committing" {
			if !canonical(operationID(parsed)) || leaseUntil == nil || !leaseUntil.After(now) || leaseUntil.After(now.Add(time.Minute)) {
				return ErrState
			}
		}
		if (r.State == "committing" || r.State == "unknown") && (!canonical(operationID(r.Data)) || operationID(r.Data) != operationID(parsed)) {
			return ErrState
		}
		if materialized > 0 {
			r, e = d.ConsumeReservation(ctx, id, materialized, version)
			if e != nil {
				return e
			}
			version = r.Version
		}
		r.State = state
		r.Data = parsed
		r.LeaseUntil = leaseUntil
		r.UpdatedAt = now
		r.ExpiresAt = now.Add(IdleLifetime)
		if r.ExpiresAt.After(r.HardExpiresAt) {
			r.ExpiresAt = r.HardExpiresAt
		}
		r, e = d.Update(ctx, r, version)
		return e
	})
	if err != nil {
		return model.PrivateTransfer{}, err
	}
	return r, err
}
func allowed(from, to string) bool {
	switch from {
	case "receiving":
		return to == "receiving" || to == "committing"
	case "preparing":
		return to == "preparing" || to == "readable" || to == "failed"
	case "readable":
		return to == "readable"
	case "committing":
		return to == "committing" || to == "committed" || to == "failed" || to == "unknown"
	case "unknown":
		return to == "unknown" || to == "committed" || to == "failed"
	default:
		return false
	}
}

// FinishCommit records a verified result for the original operation, including
// after its credential expires or cleanup is requested. It cannot reopen a
// namespace once cleanup is pending. A zero version observes the locked row;
// the operation ID still fences a late result against another commit. This is
// an internal receipt write; exposing its result requires current admission.
func (s *Lifecycle) FinishCommit(ctx context.Context, p *Permit, a Actor, id string, version int64, state string, data json.RawMessage) (model.PrivateTransfer, error) {
	if p == nil || p.owner != s || p.id != id || (state != "committed" && state != "failed") {
		return model.PrivateTransfer{}, ErrState
	}
	if err := validateActor(a); err != nil {
		return model.PrivateTransfer{}, err
	}
	parsed, err := normalizeJSON(data)
	if err != nil {
		return model.PrivateTransfer{}, ErrConflict
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return model.PrivateTransfer{}, ErrState
	}
	var result model.PrivateTransfer
	completionCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	c, txErr := s.db.WritePrivateTransfer(completionCtx, func(d store.PrivateTransferDAO) error {
		var e error
		result, e = d.Get(completionCtx, id)
		if e != nil {
			return e
		}
		// The original admitted operation owns this completion even if its
		// credential expires while the external write is finishing.
		if a != p.actor || result.UserID != a.Principal.UserID || result.AuthorityKind != a.AuthorityKind || result.AuthorityID != a.AuthorityID {
			return ErrConflict
		}
		if (version != 0 && result.Version != version) || !canonical(operationID(result.Data)) || operationID(result.Data) != operationID(parsed) {
			return ErrState
		}
		version = result.Version
		result.Data = parsed
		if result.State == "cleanup_pending" {
			if result.CleanupFromState == nil || (*result.CleanupFromState != "unknown" && *result.CleanupFromState != "committing") {
				return ErrState
			}
			result.CleanupFromState = &state
			result, e = d.UpdatePending(completionCtx, result, version)
		} else {
			if result.State != "committing" && result.State != "unknown" {
				return ErrState
			}
			result.State = state
			result.LeaseUntil = nil
			result, e = d.Update(completionCtx, result, version)
		}
		return e
	})
	err = committed(c, txErr)
	if err != nil {
		return model.PrivateTransfer{}, err
	}
	return result, nil
}

func (s *Lifecycle) CompletePending(ctx context.Context, p *Permit, a Actor, id string, version int64, state string, data json.RawMessage) (model.PrivateTransfer, error) {
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
	actor   Actor
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
func (s *Lifecycle) AcquirePermit(ctx context.Context, a Actor, id string) (*Permit, error) {
	if err := validateActor(a); err != nil {
		return nil, err
	}
	if !canonical(id) {
		return nil, ErrConflict
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
			return err
		}
		if err = authorize(opCtx, d, a, r); err != nil {
			return err
		}
		now := time.Now().UTC()
		if !live(r, now) || !contentState(r.State) {
			return ErrState
		}
		r.ExpiresAt = now.Add(IdleLifetime)
		if r.ExpiresAt.After(r.HardExpiresAt) {
			r.ExpiresAt = r.HardExpiresAt
		}
		_, err = d.Update(opCtx, r, r.Version)
		return err
	})
	if err != nil {
		_ = p.Close()
		return nil, err
	}
	return p, nil
}

// RequestCleanup persists the barrier before cancelling locally active work.
func (s *Lifecycle) RequestCleanup(ctx context.Context, a Actor, id string) (model.PrivateTransfer, error) {
	if err := validateActor(a); err != nil {
		return model.PrivateTransfer{}, err
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
		if r.State == "closed" || r.State == "cleanup_pending" {
			return nil
		}
		if r.State == "committing" {
			r.State = "unknown"
			r.LeaseUntil = nil
			r, e = d.Update(ctx, r, r.Version)
			if e != nil {
				return e
			}
		}
		r.State = "cleanup_pending"
		r.UpdatedAt = time.Now().UTC()
		r, e = d.Update(ctx, r, r.Version)
		return e
	})
	if err == nil && r.State == "cleanup_pending" {
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
	err := s.transaction(ctx, func(d store.PrivateTransferDAO) error { var e error; due, e = d.Due(ctx, now, SweepLimit); return e })
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
		if r.State != "cleanup_pending" {
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
				if current.State != "cleanup_pending" {
					return ErrState
				}
				_, err = d.Close(ctx, current.ID, current.Version, time.Now().UTC().Add(Retention))
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
	err = s.transaction(ctx, func(d store.PrivateTransferDAO) error { _, e := d.Prune(ctx, now, SweepLimit); return e })
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
		if r.State == "cleanup_pending" || r.State == "closed" {
			return nil
		}
		if r.LeaseUntil != nil && now.Before(*r.LeaseUntil) {
			return nil
		}
		leaseExpired := r.State == "committing" && (r.LeaseUntil == nil || !now.Before(*r.LeaseUntil))
		if !leaseExpired && now.Before(r.ExpiresAt) && now.Before(r.HardExpiresAt) {
			return nil
		}
		if leaseExpired {
			r.State = "unknown"
			r.LeaseUntil = nil
			r, e = d.Update(ctx, r, r.Version)
			if e != nil {
				return e
			}
		}
		r.State = "cleanup_pending"
		r.UpdatedAt = now
		r, e = d.Update(ctx, r, r.Version)
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
