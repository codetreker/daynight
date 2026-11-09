package store

import (
	"time"
)

// TaskPresence preserves deletion information until the caller has authorized access.
type TaskPresence struct {
	Found     bool
	DeletedAt *time.Time
}

// ThreadCredential retains only the locked credential's expiry for final admission.
type ThreadCredential struct {
	ExpiresAt *time.Time
}
