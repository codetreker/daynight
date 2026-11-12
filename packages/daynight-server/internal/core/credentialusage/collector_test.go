package credentialusage

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestCollectorRevisionAndCapacity(t *testing.T) {
	var c Collector
	ctx := WithCollector(context.Background(), &c)
	if CollectorFrom(ctx) != &c || CollectorFrom(context.Background()) != nil {
		t.Fatal("collector context association")
	}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	f := Fault{Phase: PhaseSubmit, Code: CodeQueueFull, Cause: CauseCapacity, Observation: obs(1, now), OccurredAt: now}
	if err := c.Record(f); err != nil {
		t.Fatal(err)
	}
	first, ok := c.Snapshot()
	if !ok {
		t.Fatal("missing fault")
	}
	f.Code = CodeWriteFailed
	if err := c.Record(f); err != nil {
		t.Fatal(err)
	}
	if c.Acknowledge(first.Revision) {
		t.Fatal("acknowledged newer fault")
	}
	second, ok := c.Snapshot()
	if !ok || second.Counts[PhaseSubmit][CodeQueueFull] != 1 || second.Counts[PhaseSubmit][CodeWriteFailed] != 1 {
		t.Fatalf("summary: %+v", second)
	}
	other := f
	other.Observation = obs(2, now)
	if err := c.Record(other); !errors.Is(err, ErrCollectorFull) {
		t.Fatalf("capacity: %v", err)
	}
	if !c.Acknowledge(second.Revision) {
		t.Fatal("acknowledge failed")
	}
	if err := c.Record(other); err != nil {
		t.Fatal(err)
	}
	if c.Acknowledge(first.Revision) || c.Acknowledge(second.Revision) {
		t.Fatal("old revision cleared reused slot")
	}
	third, ok := c.Snapshot()
	if !ok || third.First.Observation.Key() != other.Observation.Key() {
		t.Fatal("missing reused slot")
	}
	if err := c.Record(Fault{}); !errors.Is(err, ErrInvalidFault) {
		t.Fatalf("invalid fault: %v", err)
	}
}
