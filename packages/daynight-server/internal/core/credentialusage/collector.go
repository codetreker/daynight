package credentialusage

import (
	"context"
	"errors"
	"sync"
)

// ErrCollectorFull indicates that an unacknowledged subject occupies the
// request-local collector's single slot.
var ErrCollectorFull = errors.New("credential usage collector is full")

type collectorKey struct{}

// WithCollector associates a request-local collector with a synchronous caller.
// Background work must not retain this context or collector.
func WithCollector(ctx context.Context, c *Collector) context.Context {
	return context.WithValue(ctx, collectorKey{}, c)
}

// CollectorFrom returns the collector supplied by the request boundary, if any.
func CollectorFrom(ctx context.Context) *Collector {
	c, _ := ctx.Value(collectorKey{}).(*Collector)
	return c
}

// Collector holds one subject's bounded, unacknowledged request-local faults.
// Its zero value is ready for use.
type Collector struct {
	mu       sync.Mutex
	revision uint64
	summary  FaultSummary
}

// Record copies a validated fault. A different subject cannot displace an
// unacknowledged summary; callers must publish it before reusing the slot.
func (c *Collector) Record(f Fault) error {
	if !validFault(f) {
		return ErrInvalidFault
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.summary.Revision != 0 && c.summary.First.Observation.Key() != f.Observation.Key() {
		return ErrCollectorFull
	}
	c.summary.add(cloneFault(f))
	c.revision++
	c.summary.Revision = c.revision
	return nil
}

// Snapshot copies the current summary for publication without holding the lock.
func (c *Collector) Snapshot() (FaultSummary, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.summary, c.summary.Revision != 0
}

// Acknowledge clears only the published revision; a newer fault remains pending.
func (c *Collector) Acknowledge(revision uint64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if revision == 0 || c.summary.Revision != revision {
		return false
	}
	c.summary = FaultSummary{}
	return true
}
