package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// BrowserSessionDAO binds activity to an existing credential row. Locking reads
// match the actual main or preview hash and sample the primary clock only after
// acquiring the row lock; touch never creates a row or changes either hash.
type BrowserSessionDAO interface {
	BrowserSessionClock
	LockBrowserSession(context.Context, []byte, bool) (model.Session, time.Time, error)
	TouchBrowserSession(context.Context, string, time.Time, time.Time) error
}

type BrowserSessionClock interface {
	SessionTime(context.Context) (time.Time, error)
}

// BrowserSessionManagementDAO reads account-scoped non-secret projections and
// locks the caller and target by ascending ID for a revocation transaction.
type BrowserSessionManagementDAO interface {
	BrowserSessionClock
	ReadBrowserSession(context.Context, string, string, time.Time) (model.Session, error)
	ListBrowserSessions(context.Context, string, string, time.Time, *BrowserSessionPosition, int) ([]model.Session, error)
	LockBrowserSessionID(context.Context, string, string) (model.Session, error)
	DeleteBrowserSessionID(context.Context, string, string) error
}

type BrowserSessionPosition struct {
	CreatedAt time.Time
	ID        string
}
