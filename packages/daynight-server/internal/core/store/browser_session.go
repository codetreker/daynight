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
