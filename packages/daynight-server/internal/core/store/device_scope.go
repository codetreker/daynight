package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

// DeviceScopeDAO writes the decision and selection together within the identity transaction.
// Time is sampled after the device row lock to account for a wait on that lock.
type DeviceScopeDAO interface {
	FreshPATTime(context.Context, time.Time) (time.Time, error)
	SetScopedDeviceDecision(context.Context, string, string, string, []scopepolicy.ScopeID) error
}
