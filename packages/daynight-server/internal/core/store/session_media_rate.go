package store

import (
	"context"
	"time"
)

// SessionMediaRateDAO shares account limits across Sessions and relay processes.
// Each decision belongs to the caller's authorized transaction.
type SessionMediaRateDAO interface {
	TakeSessionMediaRate(context.Context, string, string, time.Time, int, int) (bool, error)
}
