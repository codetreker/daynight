package credentialusage

import (
	"sort"
	"sync"
	"time"
)

const (
	ResidentLimit = 1024
	BatchLimit    = 128
	Cooldown      = 20 * time.Second
	RetryInterval = time.Second
	MaxAttempts   = 3
)

// Admission describes in-memory acceptance, not persistence.
type Admission uint8

const (
	Accepted Admission = iota + 1
	Coalesced
	Full
	Stopped
)

type candidate struct {
	observation                      Observation
	first, born, due, retryNotBefore time.Time
	attempts                         int
}
type entry struct {
	latest                              time.Time
	pending, inflight                   *candidate
	dispatched, cooldown, failNotBefore time.Time
	fault                               FaultSummary
	exhausted                           bool
}

// Batch is an immutable copy of the selected observations. ID must be supplied
// to Complete exactly once. Observations are ordered by the store key contract.
type Batch struct {
	ID           uint64
	Observations []Observation
}

// Outcome is the confirmed result of the entire atomic batch. Unknown must be
// treated as a failure, even though a conditional write may have committed.
type Outcome uint8

const (
	Committed Outcome = iota + 1
	NotCommitted
	Unknown
)

// Failure gives safe diagnostic labels for an unconfirmed batch.
type Failure struct {
	Code     Code
	Cause    Cause
	SQLState string
}

// Snapshot is an instantaneous view of bounded state, not a persistence receipt.
type Snapshot struct {
	Sealed                                        bool
	Resident, Pending, Inflight, Dirty, Exhausted int
	Rejected, Failed, Unknown, Abandoned          uint64
	OldestPendingAge                              time.Duration
	NextDue                                       time.Time
}

// Sampler serializes its bounded state; clock must return monotonic time in
// production. It retains neither contexts nor callback references from requests.
type Sampler struct {
	mu                                   sync.Mutex
	clock                                func() time.Time
	entries                              map[Key]*entry
	batches                              map[uint64][]Key
	nextBatch                            uint64
	nextFaultRevision                    uint64
	sealed                               bool
	rejected, failed, unknown, abandoned uint64
}

func New(clock func() time.Time) *Sampler {
	if clock == nil {
		panic("credentialusage: clock is required")
	}
	return &Sampler{clock: clock, entries: make(map[Key]*entry), batches: make(map[uint64][]Key)}
}

func keyLess(a, b Key) bool {
	if a.Kind != b.Kind {
		return a.Kind < b.Kind
	}
	if a.UserID != b.UserID {
		return a.UserID < b.UserID
	}
	return a.SubjectID < b.SubjectID
}
func later(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}
func (s *Sampler) evictClean() bool {
	var selected Key
	found := false
	for k, e := range s.entries {
		if e.pending != nil || e.inflight != nil || e.fault.Revision != 0 || e.exhausted {
			continue
		}
		if !found || keyLess(k, selected) {
			selected, found = k, true
		}
	}
	if found {
		delete(s.entries, selected)
	}
	return found
}

// Record validates and copies a successful event. Older or equal timestamps do
// not replace the correlation attached to the latest event. A full or sealed
// sampler rejects the event without changing the authentication result.
func (s *Sampler) Record(o Observation) (Admission, error) {
	if !validObservation(o) {
		return 0, ErrInvalidObservation
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sealed {
		s.rejected++
		return Stopped, nil
	}
	now := s.clock()
	o = cloneObservation(o)
	k := o.Key()
	e, ok := s.entries[k]
	if !ok {
		if len(s.entries) >= ResidentLimit && !s.evictClean() {
			s.rejected++
			return Full, nil
		}
		e = &entry{}
		s.entries[k] = e
	}
	if !e.latest.IsZero() && !o.Event.At.After(e.latest) {
		return Coalesced, nil
	}
	e.latest = o.Event.At
	if e.pending != nil {
		e.pending.observation = o
		if e.pending.attempts > 0 {
			e.pending.attempts = 0
		}
		return Coalesced, nil
	}
	due := now
	if e.inflight != nil {
		due = later(due, e.dispatched.Add(Cooldown))
	} else if !e.cooldown.IsZero() {
		due = later(due, e.cooldown)
	}
	due = later(due, e.failNotBefore)
	e.pending = &candidate{observation: o, first: now, born: now, due: due, retryNotBefore: e.failNotBefore}
	return Accepted, nil
}

// TakeDue selects at most BatchLimit eligible keys by due and first pending
// time, then returns them in canonical store order. It never waits.
func (s *Sampler) TakeDue() Batch {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock()
	type choice struct {
		key Key
		c   *candidate
	}
	choices := make([]choice, 0, len(s.entries))
	for k, e := range s.entries {
		if e.pending != nil && e.inflight == nil && !e.pending.due.After(now) {
			choices = append(choices, choice{k, e.pending})
		}
	}
	sort.Slice(choices, func(i, j int) bool {
		a, b := choices[i], choices[j]
		if !a.c.due.Equal(b.c.due) {
			return a.c.due.Before(b.c.due)
		}
		if !a.c.first.Equal(b.c.first) {
			return a.c.first.Before(b.c.first)
		}
		return keyLess(a.key, b.key)
	})
	if len(choices) > BatchLimit {
		choices = choices[:BatchLimit]
	}
	if len(choices) == 0 {
		return Batch{}
	}
	sort.Slice(choices, func(i, j int) bool { return keyLess(choices[i].key, choices[j].key) })
	s.nextBatch++
	if s.nextBatch == 0 {
		panic("credentialusage: batch ID exhausted")
	}
	batch := Batch{ID: s.nextBatch, Observations: make([]Observation, 0, len(choices))}
	keys := make([]Key, 0, len(choices))
	for _, c := range choices {
		e := s.entries[c.key]
		e.inflight = e.pending
		e.pending = nil
		e.inflight.attempts++
		e.dispatched = now
		batch.Observations = append(batch.Observations, e.inflight.observation)
		keys = append(keys, c.key)
	}
	s.batches[batch.ID] = keys
	return batch
}

// Complete confirms a batch once. Failures are retained as bounded diagnostics;
// each candidate has at most three attempts and retries wait at least one second.
// A newer event received during a failed attempt gets its own attempt budget.
func (s *Sampler) Complete(id uint64, outcome Outcome, failure Failure) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	keys, ok := s.batches[id]
	if !ok {
		return ErrUnknownBatch
	}
	if outcome < Committed || outcome > Unknown {
		return ErrInvalidFault
	}
	if outcome != Committed {
		if failure.Code != CodeWriteTimeout && failure.Code != CodeWriteFailed && failure.Code != CodeWriteOutcomeUnknown || outcome == Unknown && failure.Code != CodeWriteOutcomeUnknown || outcome == NotCommitted && failure.Code == CodeWriteOutcomeUnknown {
			return ErrInvalidFault
		}
		f := Fault{Phase: PhaseFlush, Code: failure.Code, Cause: failure.Cause, Observation: s.entries[keys[0]].inflight.observation, OccurredAt: s.clock(), Depth: len(s.entries), SQLState: failure.SQLState}
		if !validFault(f) {
			return ErrInvalidFault
		}
	}
	now := s.clock()
	delete(s.batches, id)
	for _, k := range keys {
		e := s.entries[k]
		old := e.inflight
		e.inflight = nil
		if outcome == Committed {
			e.exhausted = false
			e.cooldown = e.dispatched.Add(Cooldown)
			e.failNotBefore = time.Time{}
			if e.pending != nil {
				e.pending.due = later(e.pending.first, e.cooldown)
				if s.sealed {
					e.pending.due = e.pending.first
				}
			}
			continue
		}
		s.failed++
		if outcome == Unknown {
			s.unknown++
		}
		f := Fault{Phase: PhaseFlush, Code: failure.Code, Cause: failure.Cause, Observation: old.observation, OccurredAt: now, PendingAge: now.Sub(old.born), Depth: len(s.entries), SQLState: failure.SQLState}
		if f.PendingAge < 0 {
			f.PendingAge = 0
		}
		s.addFault(e, cloneFault(f))
		e.failNotBefore = now.Add(RetryInterval)
		if e.pending == nil {
			if old.attempts >= MaxAttempts {
				e.exhausted = true
				s.abandoned++
				continue
			}
			e.pending = old
		} else {
			if old.born.Before(e.pending.born) {
				e.pending.born = old.born
			}
			if old.attempts >= MaxAttempts {
				e.exhausted = true
				s.abandoned++
			}
		}
		e.pending.first = now
		e.pending.retryNotBefore = e.failNotBefore
		e.pending.due = e.pending.retryNotBefore
	}
	return nil
}

func (s *Sampler) addFault(e *entry, f Fault) {
	if s.nextFaultRevision == ^uint64(0) {
		panic("credentialusage: fault revision exhausted")
	}
	s.nextFaultRevision++
	e.fault.add(f)
	e.fault.Revision = s.nextFaultRevision
}

// ReportFault records an additional safe fault for an existing resident key.
// No new resident is allocated for a rejected event.
func (s *Sampler) ReportFault(f Fault) error {
	if !validFault(f) {
		return ErrInvalidFault
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entries[f.Observation.Key()]
	if e == nil {
		return ErrInvalidObservation
	}
	s.addFault(e, cloneFault(f))
	return nil
}

// Faults returns independent snapshots of dirty summaries in key order.
func (s *Sampler) Faults() []FaultSummary {
	s.mu.Lock()
	defer s.mu.Unlock()
	keys := make([]Key, 0)
	for k, e := range s.entries {
		if e.fault.Revision != 0 {
			keys = append(keys, k)
		}
	}
	sort.Slice(keys, func(i, j int) bool { return keyLess(keys[i], keys[j]) })
	result := make([]FaultSummary, 0, len(keys))
	for _, k := range keys {
		result = append(result, s.entries[k].fault)
	}
	return result
}

// AcknowledgeFault clears only the exact copied revision; false means the
// summary changed, was already confirmed, or the key is no longer resident.
func (s *Sampler) AcknowledgeFault(k Key, revision uint64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entries[k]
	if e == nil || revision == 0 || e.fault.Revision != revision {
		return false
	}
	e.fault = FaultSummary{}
	return true
}

// Seal rejects new events and makes pending work immediately eligible, except
// for a retry's minimum spacing. Inflight work must still be completed.
func (s *Sampler) Seal() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sealed {
		return
	}
	s.sealed = true
	now := s.clock()
	for _, e := range s.entries {
		if e.pending != nil {
			e.pending.due = later(now, e.pending.retryNotBefore)
		}
	}
}

// Snapshot exposes counts and the earliest schedulable time to the driver.
func (s *Sampler) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock()
	v := Snapshot{Sealed: s.sealed, Resident: len(s.entries), Rejected: s.rejected, Failed: s.failed, Unknown: s.unknown, Abandoned: s.abandoned}
	for _, e := range s.entries {
		if e.pending != nil {
			v.Pending++
			age := now.Sub(e.pending.born)
			if age > v.OldestPendingAge {
				v.OldestPendingAge = age
			}
			if e.inflight == nil && (v.NextDue.IsZero() || e.pending.due.Before(v.NextDue)) {
				v.NextDue = e.pending.due
			}
		}
		if e.inflight != nil {
			v.Inflight++
			age := now.Sub(e.inflight.born)
			if age > v.OldestPendingAge {
				v.OldestPendingAge = age
			}
		}
		if e.fault.Revision != 0 {
			v.Dirty++
		}
		if e.exhausted {
			v.Exhausted++
		}
	}
	return v
}
