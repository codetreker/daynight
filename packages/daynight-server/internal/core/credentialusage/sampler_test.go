package credentialusage

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
	"unsafe"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type fakeClock struct{ now time.Time }

func (c *fakeClock) advance(d time.Duration) { c.now = c.now.Add(d) }
func newSampler() (*Sampler, *fakeClock) {
	c := &fakeClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	return New(func() time.Time { return c.now }), c
}
func obs(n int, at time.Time) Observation {
	return Observation{Event: model.CredentialUsageEvent{Kind: model.UsageSubjectPAT, UserID: "00000000-0000-4000-8000-000000000001", SubjectID: fmt.Sprintf("00000000-0000-4000-8000-%012x", n), At: at.UTC().Truncate(time.Microsecond)}, RequestID: fmt.Sprintf("request-%d", n), Source: SourceHTTPPAT}
}
func record(t *testing.T, s *Sampler, o Observation, want Admission) {
	t.Helper()
	got, err := s.Record(o)
	if err != nil || got != want {
		t.Fatalf("Record = %v, %v; want %v", got, err, want)
	}
}
func take(t *testing.T, s *Sampler, n int) Batch {
	t.Helper()
	b := s.TakeDue()
	if len(b.Observations) != n {
		t.Fatalf("TakeDue returned %d, want %d; state %+v", len(b.Observations), n, s.Snapshot())
	}
	return b
}
func complete(t *testing.T, s *Sampler, b Batch, outcome Outcome, f Failure) {
	t.Helper()
	if err := s.Complete(b.ID, outcome, f); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsRetainRealEvents(t *testing.T) {
	s, c := newSampler()
	start := c.now
	a := obs(1, start)
	record(t, s, a, Accepted)
	b := take(t, s, 1)
	complete(t, s, b, Committed, Failure{})
	c.advance(5 * time.Second)
	newer := obs(1, c.now)
	newer.RequestID = "request-new"
	record(t, s, newer, Accepted)
	c.advance(2 * time.Second)
	older := obs(1, start.Add(time.Second))
	record(t, s, older, Coalesced)
	equal := newer
	equal.RequestID = "other"
	record(t, s, equal, Coalesced)
	c.advance(12 * time.Second)
	take(t, s, 0)
	c.advance(time.Second)
	b = take(t, s, 1)
	if b.Observations[0] != newer {
		t.Fatalf("lost event association: %+v", b.Observations[0])
	}
	complete(t, s, b, Committed, Failure{})
	// Dense traffic spanning windows advances, and a final sparse event is never fabricated.
	for window := 0; window < 4; window++ {
		for i := 0; i < 4; i++ {
			c.advance(5 * time.Second)
			event := obs(1, c.now)
			if i == 0 {
				record(t, s, event, Accepted)
			} else {
				record(t, s, event, Coalesced)
			}
		}
		b = take(t, s, 1)
		if !b.Observations[0].Event.At.Equal(c.now) {
			t.Fatal("did not select latest real event")
		}
		complete(t, s, b, Committed, Failure{})
	}
	c.advance(time.Second)
	last := obs(1, c.now)
	record(t, s, last, Accepted)
	c.advance(19 * time.Second)
	b = take(t, s, 1)
	if b.Observations[0] != last {
		t.Fatal("did not retain final real event")
	}
	complete(t, s, b, Committed, Failure{})
	c.advance(time.Minute)
	take(t, s, 0)
}

func TestInflightAndSeal(t *testing.T) {
	s, c := newSampler()
	first := obs(1, c.now)
	record(t, s, first, Accepted)
	b := take(t, s, 1)
	c.advance(time.Second)
	next := obs(1, c.now)
	record(t, s, next, Accepted)
	complete(t, s, b, Committed, Failure{})
	take(t, s, 0)
	s.Seal()
	s.Seal()
	record(t, s, obs(2, c.now), Stopped)
	b = take(t, s, 1)
	if b.Observations[0] != next {
		t.Fatal("inflight update was lost")
	}
	complete(t, s, b, Committed, Failure{})
	take(t, s, 0)
	if v := s.Snapshot(); !v.Sealed || v.Pending != 0 || v.Inflight != 0 || v.Rejected != 1 {
		t.Fatalf("bad seal snapshot %+v", v)
	}
}

func TestRetriesAndNewBudget(t *testing.T) {
	s, c := newSampler()
	o := obs(1, c.now)
	record(t, s, o, Accepted)
	failure := Failure{Code: CodeWriteFailed, Cause: CauseDatabase, SQLState: "55P03"}
	for i := 0; i < 3; i++ {
		b := take(t, s, 1)
		if b.Observations[0] != o {
			t.Fatal("retry changed event")
		}
		complete(t, s, b, NotCommitted, failure)
		if i < 2 {
			take(t, s, 0)
			c.advance(RetryInterval)
		}
	}
	if v := s.Snapshot(); v.Failed != 3 || v.Abandoned != 1 || v.Pending != 0 || v.Dirty != 1 {
		t.Fatalf("exhaustion %+v", v)
	}
	record(t, s, o, Coalesced)
	c.advance(time.Second)
	take(t, s, 0)
	o2 := obs(1, c.now)
	record(t, s, o2, Accepted)
	b := take(t, s, 1)
	complete(t, s, b, Unknown, Failure{Code: CodeWriteOutcomeUnknown, Cause: CauseUnknown})
	s.Seal()
	take(t, s, 0)
	c.advance(time.Second)
	b = take(t, s, 1)
	complete(t, s, b, Committed, Failure{})
	if v := s.Snapshot(); v.Unknown != 1 || v.Pending != 0 {
		t.Fatalf("new candidate %+v", v)
	}
}

func TestNewerEventReplacesRetryAndGetsFreshBudget(t *testing.T) {
	s, c := newSampler()
	old := obs(1, c.now)
	record(t, s, old, Accepted)
	f := Failure{Code: CodeWriteTimeout, Cause: CauseTimeout}
	for i := 0; i < 2; i++ {
		b := take(t, s, 1)
		complete(t, s, b, NotCommitted, f)
		c.advance(time.Second)
	}
	// New event is merged into a pending retry. It is not charged for old attempts.
	fresh := obs(1, c.now)
	record(t, s, fresh, Coalesced)
	for i := 0; i < 3; i++ {
		b := take(t, s, 1)
		if b.Observations[0] != fresh {
			t.Fatal("wrong candidate")
		}
		complete(t, s, b, NotCommitted, f)
		if i < 2 {
			c.advance(time.Second)
		}
	}
	if v := s.Snapshot(); v.Failed != 5 || v.Abandoned != 1 || v.Pending != 0 {
		t.Fatalf("bad budget %+v", v)
	}
}

func TestFaultRevisionAndCapacity(t *testing.T) {
	s, c := newSampler()
	for i := 1; i <= ResidentLimit; i++ {
		record(t, s, obs(i, c.now), Accepted)
	}
	record(t, s, obs(ResidentLimit+1, c.now), Full)
	b := take(t, s, BatchLimit)
	first := b.Observations[0]
	complete(t, s, b, NotCommitted, Failure{Code: CodeWriteFailed, Cause: CauseDatabase})
	summaries := s.Faults()
	if len(summaries) != BatchLimit || summaries[0].Counts[PhaseFlush][CodeWriteFailed] != 1 {
		t.Fatal("missing summary")
	}
	rev := summaries[0].Revision
	f := Fault{Phase: PhaseFlush, Code: CodeLagExceeded, Cause: CauseNone, Observation: first, OccurredAt: c.now, Depth: ResidentLimit}
	if err := s.ReportFault(f); err != nil {
		t.Fatal(err)
	}
	if s.AcknowledgeFault(first.Key(), rev) {
		t.Fatal("cleared newer fault")
	}
	newer := s.Faults()[0]
	if newer.Counts[PhaseFlush][CodeWriteFailed] != 1 || newer.Counts[PhaseFlush][CodeLagExceeded] != 1 || newer.First.Observation != first || newer.Latest.Code != CodeLagExceeded {
		t.Fatal("lost fixed fault counts")
	}
	if !s.AcknowledgeFault(first.Key(), newer.Revision) {
		t.Fatal("ack failed")
	}
	if err := s.ReportFault(f); err != nil {
		t.Fatal(err)
	}
	if s.AcknowledgeFault(first.Key(), newer.Revision) {
		t.Fatal("reused a revision after acknowledgement")
	}
	// Pending keys and dirty keys cannot be evicted. A clean key can be.
	batch := take(t, s, BatchLimit)
	complete(t, s, batch, Committed, Failure{})
	record(t, s, obs(ResidentLimit+1, c.now), Accepted)
}

func TestFairnessAndNormalBudget(t *testing.T) {
	s, c := newSampler()
	start := c.now
	for i := 1; i <= ResidentLimit; i++ {
		record(t, s, obs(i, start), Accepted)
	}
	c.advance(time.Second)
	for round := 0; round < 8; round++ {
		b := take(t, s, BatchLimit)
		c.advance(2 * time.Second)
		complete(t, s, b, Committed, Failure{})
	}
	if got := c.now.Sub(start); got != 17*time.Second {
		t.Fatalf("first budget %s", got)
	}
	// Fill a second window; repeatedly updating a hot key must not move its due.
	for i := 1; i <= ResidentLimit; i++ {
		record(t, s, obs(i, c.now), Accepted)
	}
	c.advance(4 * time.Second)
	for round := 0; round < 8; round++ {
		record(t, s, obs(ResidentLimit, c.now), Coalesced)
		b := take(t, s, BatchLimit)
		c.advance(2 * time.Second)
		complete(t, s, b, Committed, Failure{})
	}
	if v := s.Snapshot(); v.Pending != 0 || v.Inflight != 0 {
		t.Fatalf("starved keys %+v", v)
	}
	// The latest first-window dispatch was at t=15; its last window ends at 35.
	// A one-second poll plus eight two-second batches completes by t=52 (37s).
	if got := c.now.Sub(start); got > 52*time.Second {
		t.Fatalf("second window exceeded bound: %s", got)
	}
}

func TestValidationAndBatchIdentity(t *testing.T) {
	s, c := newSampler()
	o := obs(1, c.now)
	bad := o
	bad.Event.At = bad.Event.At.Add(time.Nanosecond)
	if _, err := s.Record(bad); err != ErrInvalidObservation {
		t.Fatal(err)
	}
	bad = o
	bad.RequestID = "bad secret"
	if _, err := s.Record(bad); err != ErrInvalidObservation {
		t.Fatal(err)
	}
	bad = o
	bad.Event.UserID = "BAD"
	if _, err := s.Record(bad); err != ErrInvalidObservation {
		t.Fatal(err)
	}
	record(t, s, o, Accepted)
	b := take(t, s, 1)
	if err := s.Complete(b.ID, Unknown, Failure{Code: CodeWriteFailed, Cause: CauseDatabase}); err != ErrInvalidFault {
		t.Fatal(err)
	}
	complete(t, s, b, Committed, Failure{})
	if err := s.Complete(b.ID, Committed, Failure{}); err != ErrUnknownBatch {
		t.Fatal(err)
	}
	f := Fault{Phase: PhaseFlush, Code: CodeWriteFailed, Cause: CauseDatabase, Observation: o, OccurredAt: c.now, SQLState: "secret"}
	if s.ReportFault(f) != ErrInvalidFault {
		t.Fatal("unsafe sqlstate accepted")
	}
}

func TestTailBudgetUsesActualOperations(t *testing.T) {
	s, c := newSampler()
	start := c.now
	for i := 1; i <= ResidentLimit; i++ {
		record(t, s, obs(i, start), Accepted)
	}
	// All initial dispatches complete at the same instant, creating the worst
	// common cooldown deadline without assuming a measured database throughput.
	for i := 0; i < 8; i++ {
		b := take(t, s, BatchLimit)
		complete(t, s, b, Committed, Failure{})
	}
	c.advance(time.Second)
	for i := 1; i <= ResidentLimit; i++ {
		record(t, s, obs(i, c.now), Accepted)
	}
	c.advance(20 * time.Second) // 20 seconds of cooldown plus one-second polling delay
	for i := 0; i < 8; i++ {
		b := take(t, s, BatchLimit)
		c.advance(2 * time.Second)
		complete(t, s, b, Committed, Failure{})
	}
	if got := c.now.Sub(start); got != 37*time.Second {
		t.Fatalf("tail budget = %s", got)
	}
	if v := s.Snapshot(); v.Pending != 0 || v.Inflight != 0 {
		t.Fatalf("unfinished work: %+v", v)
	}
}

func TestSelectionFairnessAndCanonicalBatchOrder(t *testing.T) {
	s, c := newSampler()
	start := c.now
	// The old first-pending key has a lexically greater identifier, and must win
	// selection before the newer lower identifiers despite canonical output order.
	record(t, s, obs(1000, start), Accepted)
	c.advance(time.Second)
	for i := 1; i <= BatchLimit; i++ {
		record(t, s, obs(i, c.now), Accepted)
	}
	c.advance(time.Second)
	hot := obs(1000, c.now)
	record(t, s, hot, Coalesced)
	b := take(t, s, BatchLimit)
	if b.Observations[len(b.Observations)-1] != hot {
		t.Fatal("first pending key starved or lost its event")
	}
	for i := 1; i < len(b.Observations); i++ {
		if !keyLess(b.Observations[i-1].Key(), b.Observations[i].Key()) {
			t.Fatal("batch is not in store key order")
		}
	}
	complete(t, s, b, Committed, Failure{})
	b = take(t, s, 1)
	if b.Observations[0].Key() != obs(BatchLimit, c.now).Key() {
		t.Fatal("wrong key left for next batch")
	}
}

func TestSafeDiagnosticVocabulary(t *testing.T) {
	phases := map[Phase]string{PhaseSubmit: "submit", PhaseFlush: "flush", PhaseRotation: "rotation", PhaseShutdown: "shutdown", 0: ""}
	for value, want := range phases {
		if got := value.String(); got != want {
			t.Fatalf("phase %d = %q", value, got)
		}
	}
	codes := map[Code]string{CodeQueueFull: "queue_full", CodeWriteTimeout: "write_timeout", CodeWriteFailed: "write_failed", CodeWriteOutcomeUnknown: "write_outcome_unknown", CodeRotationOutcomeUnknown: "rotation_outcome_unknown", CodeLagExceeded: "lag_exceeded", CodeShutdownIncomplete: "shutdown_incomplete", 0: ""}
	for value, want := range codes {
		if got := value.String(); got != want {
			t.Fatalf("code %d = %q", value, got)
		}
	}
	causes := map[Cause]string{CauseNone: "none", CauseTimeout: "timeout", CauseCancelled: "cancelled", CauseDatabase: "database", CauseUnknown: "unknown", CauseCapacity: "capacity", CauseStopped: "stopped", causeEnd: ""}
	for value, want := range causes {
		if got := value.String(); got != want {
			t.Fatalf("cause %d = %q", value, got)
		}
	}
	sources := map[Source]string{SourceHTTPPAT: "http_pat", SourceMCPPAT: "mcp_pat", SourceMCPOAuth: "mcp_oauth", SourceOAuthRefresh: "oauth_refresh", 0: ""}
	for value, want := range sources {
		if got := value.String(); got != want {
			t.Fatalf("source %d = %q", value, got)
		}
	}
}

func TestSnapshotTracksPendingAndInflightAge(t *testing.T) {
	s, c := newSampler()
	record(t, s, obs(1, c.now), Accepted)
	b := take(t, s, 1)
	c.advance(3 * time.Second)
	record(t, s, obs(1, c.now), Accepted)
	v := s.Snapshot()
	if v.Resident != 1 || v.Pending != 1 || v.Inflight != 1 || v.OldestPendingAge != 3*time.Second || !v.NextDue.IsZero() {
		t.Fatalf("inflight %+v", v)
	}
	complete(t, s, b, Committed, Failure{})
	v = s.Snapshot()
	if v.Inflight != 0 || v.OldestPendingAge != 0 || !v.NextDue.Equal(c.now.Add(17*time.Second)) {
		t.Fatalf("pending %+v", v)
	}
	c.advance(4 * time.Second)
	v = s.Snapshot()
	if v.OldestPendingAge != 4*time.Second {
		t.Fatalf("age %+v", v)
	}
}

func TestNewerInflightOnFinalFailure(t *testing.T) {
	s, c := newSampler()
	old := obs(1, c.now)
	record(t, s, old, Accepted)
	f := Failure{Code: CodeWriteFailed, Cause: CauseDatabase}
	for i := 0; i < 2; i++ {
		b := take(t, s, 1)
		complete(t, s, b, NotCommitted, f)
		c.advance(time.Second)
	}
	b := take(t, s, 1)
	c.advance(time.Second)
	newer := obs(1, c.now)
	record(t, s, newer, Accepted)
	complete(t, s, b, NotCommitted, f)
	if v := s.Snapshot(); v.Abandoned != 1 || v.Pending != 1 {
		t.Fatalf("new candidate lost %+v", v)
	}
	c.advance(time.Second)
	b = take(t, s, 1)
	if b.Observations[0] != newer {
		t.Fatal("wrong new event")
	}
	complete(t, s, b, Committed, Failure{})
}

func TestDiagnosticValidationAndKeyOrdering(t *testing.T) {
	s, c := newSampler()
	o := obs(1, c.now)
	record(t, s, o, Accepted)
	invalid := []Fault{
		{Phase: 0, Code: CodeWriteFailed, Observation: o, OccurredAt: c.now},
		{Phase: PhaseFlush, Code: codeEnd, Observation: o, OccurredAt: c.now},
		{Phase: PhaseFlush, Code: CodeWriteFailed, Cause: causeEnd, Observation: o, OccurredAt: c.now},
		{Phase: PhaseFlush, Code: CodeWriteFailed, Observation: o, OccurredAt: c.now, Depth: ResidentLimit + 1},
		{Phase: PhaseFlush, Code: CodeWriteFailed, Observation: o, OccurredAt: c.now, PendingAge: -time.Second},
		{Phase: PhaseFlush, Code: CodeWriteFailed, Observation: o, OccurredAt: c.now, SQLState: "!!!!"},
		{Phase: PhaseFlush, Code: CodeWriteFailed, Observation: o, OccurredAt: c.now, SQLState: "1234!"},
	}
	for _, f := range invalid {
		if s.ReportFault(f) != ErrInvalidFault {
			t.Fatalf("accepted invalid fault %+v", f)
		}
	}
	missing := Fault{Phase: PhaseFlush, Code: CodeWriteFailed, Observation: obs(2, c.now), OccurredAt: c.now}
	if s.ReportFault(missing) != ErrInvalidObservation {
		t.Fatal("missing key accepted")
	}
	a, b := o.Key(), o.Key()
	b.Kind = model.UsageSubjectOAuthGrant
	if !keyLess(b, a) {
		t.Fatal("kind order")
	}
	b = a
	b.UserID = "00000000-0000-4000-8000-000000000002"
	if !keyLess(a, b) {
		t.Fatal("user order")
	}
}

func TestNewEventAfterExhaustionKeepsFailureSpacing(t *testing.T) {
	s, c := newSampler()
	record(t, s, obs(1, c.now), Accepted)
	failure := Failure{Code: CodeWriteFailed, Cause: CauseDatabase}
	for i := 0; i < 3; i++ {
		b := take(t, s, 1)
		complete(t, s, b, NotCommitted, failure)
		if i < 2 {
			c.advance(time.Second)
		}
	}
	c.advance(time.Microsecond)
	fresh := obs(1, c.now)
	record(t, s, fresh, Accepted)
	s.Seal()
	take(t, s, 0)
	c.advance(time.Second - time.Microsecond)
	b := take(t, s, 1)
	if b.Observations[0] != fresh {
		t.Fatal("new observation lost")
	}
	complete(t, s, b, Committed, Failure{})
}

func TestObservationsCopyBoundedStrings(t *testing.T) {
	s, c := newSampler()
	o := obs(1, c.now)
	// The allowed prefixes refer to much larger request-owned buffers.
	prefix := func(value string) string { return (value + strings.Repeat("x", 4096))[:len(value)] }
	o.Event.Kind = model.UsageSubjectKind(prefix(string(o.Event.Kind)))
	o.Event.UserID = prefix(o.Event.UserID)
	o.Event.SubjectID = prefix(o.Event.SubjectID)
	o.RequestID = prefix(o.RequestID)
	record(t, s, o, Accepted)
	b := take(t, s, 1)
	copied := b.Observations[0]
	for _, pair := range [][2]string{{o.Event.UserID, copied.Event.UserID}, {o.Event.SubjectID, copied.Event.SubjectID}, {o.RequestID, copied.RequestID}, {string(o.Event.Kind), string(copied.Event.Kind)}} {
		if pair[0] != pair[1] || unsafe.StringData(pair[0]) == unsafe.StringData(pair[1]) {
			t.Fatal("observation retained request-owned string storage")
		}
	}
	complete(t, s, b, Committed, Failure{})
	at := c.now.In(time.FixedZone(prefix("external"), 3600))
	f := Fault{Phase: PhaseFlush, Code: CodeWriteFailed, Cause: CauseDatabase, Observation: o, OccurredAt: at, SQLState: prefix("55P03")}
	if err := s.ReportFault(f); err != nil {
		t.Fatal(err)
	}
	saved := s.Faults()[0].Latest
	for _, pair := range [][2]string{{o.Event.UserID, saved.Observation.Event.UserID}, {o.Event.SubjectID, saved.Observation.Event.SubjectID}, {o.RequestID, saved.Observation.RequestID}, {f.SQLState, saved.SQLState}} {
		if pair[0] != pair[1] || unsafe.StringData(pair[0]) == unsafe.StringData(pair[1]) {
			t.Fatal("fault retained request-owned string storage")
		}
	}
	if saved.OccurredAt.Location() != time.UTC || !saved.OccurredAt.Equal(at) {
		t.Fatal("fault time was not normalized to UTC")
	}
}

func TestLagAgeSurvivesFailedUpdates(t *testing.T) {
	s, c := newSampler()
	record(t, s, obs(1, c.now), Accepted)
	f := Failure{Code: CodeWriteFailed, Cause: CauseDatabase}
	for i := 0; i < 7; i++ {
		b := take(t, s, 1)
		c.advance(10 * time.Second)
		record(t, s, obs(1, c.now), Accepted)
		complete(t, s, b, NotCommitted, f)
		c.advance(time.Second)
		record(t, s, obs(1, c.now), Coalesced)
	}
	if v := s.Snapshot(); v.OldestPendingAge != 77*time.Second {
		t.Fatalf("failure age hidden by updates: %+v", v)
	}
	b := take(t, s, 1)
	complete(t, s, b, Committed, Failure{})
	if v := s.Snapshot(); v.OldestPendingAge != 0 {
		t.Fatalf("committed age retained: %+v", v)
	}
}

func TestFaultRevisionSurvivesEvictionAndReadmission(t *testing.T) {
	s, c := newSampler()
	original := obs(1, c.now)
	for i := 1; i <= ResidentLimit; i++ {
		record(t, s, obs(i, c.now), Accepted)
	}
	for i := 0; i < ResidentLimit/BatchLimit; i++ {
		b := take(t, s, BatchLimit)
		complete(t, s, b, Committed, Failure{})
	}
	f := Fault{Phase: PhaseFlush, Code: CodeLagExceeded, Cause: CauseNone, Observation: original, OccurredAt: c.now}
	if err := s.ReportFault(f); err != nil {
		t.Fatal(err)
	}
	old := s.Faults()[0].Revision
	if !s.AcknowledgeFault(original.Key(), old) {
		t.Fatal("first ack failed")
	}
	record(t, s, obs(ResidentLimit+1, c.now), Accepted)
	if err := s.ReportFault(f); err != ErrInvalidObservation {
		t.Fatal("expected original key to be evicted")
	}
	record(t, s, original, Accepted)
	if err := s.ReportFault(f); err != nil {
		t.Fatal(err)
	}
	current := s.Faults()[0].Revision
	if current <= old || s.AcknowledgeFault(original.Key(), old) {
		t.Fatal("stale ack removed fault for readmitted key")
	}
	if !s.AcknowledgeFault(original.Key(), current) {
		t.Fatal("current acknowledgement failed")
	}
}

func TestFaultRevisionExhaustionDoesNotWrap(t *testing.T) {
	s, c := newSampler()
	o := obs(1, c.now)
	record(t, s, o, Accepted)
	f := Fault{Phase: PhaseFlush, Code: CodeLagExceeded, Observation: o, OccurredAt: c.now}
	s.nextFaultRevision = ^uint64(0) - 1
	if err := s.ReportFault(f); err != nil {
		t.Fatal(err)
	}
	if s.Faults()[0].Revision != ^uint64(0) {
		t.Fatal("last revision not retained")
	}
	for i := 0; i < 2; i++ {
		func() {
			defer func() {
				if recover() == nil {
					t.Error("exhaustion did not panic")
				}
			}()
			_ = s.ReportFault(f)
		}()
	}
	if s.Faults()[0].Revision != ^uint64(0) {
		t.Fatal("revision wrapped")
	}
}

func TestConcurrentRecordKeepsLatestEventAssociation(t *testing.T) {
	s, c := newSampler()
	start := c.now
	c.advance(time.Minute)
	const count = 128
	gate := make(chan struct{})
	results := make(chan error, count)
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-gate
			o := obs(1, start.Add(time.Duration(i)*time.Microsecond))
			o.RequestID = fmt.Sprintf("event-%d", i)
			admission, err := s.Record(o)
			if err != nil {
				results <- err
				return
			}
			if admission != Accepted && admission != Coalesced {
				results <- fmt.Errorf("unexpected admission: %d", admission)
			}
		}(i)
	}
	close(gate)
	wg.Wait()
	close(results)
	for err := range results {
		t.Fatal(err)
	}
	b := take(t, s, 1)
	got := b.Observations[0]
	if !got.Event.At.Equal(start.Add((count-1)*time.Microsecond)) || got.RequestID != fmt.Sprintf("event-%d", count-1) {
		t.Fatalf("latest event association lost: %+v", got)
	}
	complete(t, s, b, Committed, Failure{})
}

func TestExhaustedCandidateSurvivesCapacityAndReplay(t *testing.T) {
	s, c := newSampler()
	old := obs(1, c.now)
	record(t, s, old, Accepted)
	failure := Failure{Code: CodeWriteFailed, Cause: CauseDatabase}
	for i := 0; i < MaxAttempts; i++ {
		b := take(t, s, 1)
		complete(t, s, b, NotCommitted, failure)
		if i < MaxAttempts-1 {
			c.advance(time.Second)
		}
	}
	summaries := s.Faults()
	if !s.AcknowledgeFault(old.Key(), summaries[0].Revision) {
		t.Fatal("fault ack failed")
	}
	for i := 2; i <= ResidentLimit; i++ {
		record(t, s, obs(i, c.now), Accepted)
	}
	record(t, s, obs(ResidentLimit+1, c.now), Full)
	record(t, s, old, Coalesced)
	if v := s.Snapshot(); v.Exhausted != 1 || v.Pending != ResidentLimit-1 {
		t.Fatalf("exhaustion lost under capacity pressure %+v", v)
	}
	c.advance(time.Second)
	fresh := obs(1, c.now)
	record(t, s, fresh, Accepted)
	found := false
	for i := 0; i < ResidentLimit/BatchLimit; i++ {
		b := take(t, s, BatchLimit)
		for _, o := range b.Observations {
			if o.Key() == old.Key() {
				found = true
				if o != fresh {
					t.Fatal("replayed exhausted event")
				}
			}
		}
		complete(t, s, b, Committed, Failure{})
	}
	if !found {
		t.Fatal("newer event was not selected")
	}
	if v := s.Snapshot(); v.Exhausted != 0 {
		t.Fatalf("successful newer event retained marker %+v", v)
	}
	record(t, s, obs(ResidentLimit+1, c.now), Accepted)
}

func TestNewRejectsMissingClock(t *testing.T) {
	defer func() {
		if got := recover(); got != "credentialusage: clock is required" {
			t.Fatalf("missing clock panic = %v", got)
		}
	}()
	_ = New(nil)
}
