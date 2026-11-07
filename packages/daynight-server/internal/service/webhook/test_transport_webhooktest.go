//go:build webhooktest

package webhook

import (
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
)

// SetControlledTestTransport is available only in the dedicated webhooktest build.
func (r *Runner) SetControlledTestTransport(client *httpoutbound.Client) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if client == nil || r.cancel != nil || r.finished != nil {
		return errors.New("test transport must be set before start")
	}
	r.client = client
	return nil
}

// ControlledTestDone exposes only the test build's worker completion signal.
func (r *Runner) ControlledTestDone() <-chan struct{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.finished
}
