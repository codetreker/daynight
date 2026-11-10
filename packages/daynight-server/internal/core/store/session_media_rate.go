package store

import (
	"context"
	"time"
)

type SessionMediaRate struct {
	Tokens    int64
	UpdatedAt time.Time
}

// SessionMediaRateDAO serializes an account bucket inside the caller's authorized
// transaction. Core supplies both the initial state and each decided replacement.
type SessionMediaRateDAO interface {
	LockSessionMediaRate(context.Context, string, string, SessionMediaRate) (SessionMediaRate, error)
	SaveSessionMediaRate(context.Context, string, string, SessionMediaRate) error
}
