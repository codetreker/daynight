package webhook

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"time"
)

// SetTestTransport replaces network dependencies only in the test binary.
func (r *Runner) SetTestTransport(c *httpoutbound.Client) { r.client = c }

func (r *Runner) SetTestPollInterval(interval time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if interval <= 0 || r.finished != nil {
		panic("test polling interval must be positive and set before start")
	}
	r.pollInterval = interval
}

func (r *Retention) SetTestRetryInterval(interval time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if interval <= 0 || r.done != nil {
		panic("test retry interval must be positive and set before start")
	}
	r.retryInterval = interval
}

func (r *Retention) SetTestPassTimeout(timeout time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if timeout <= 0 || r.done != nil {
		panic("test pass timeout must be positive and set before start")
	}
	r.passTimeout = timeout
}
