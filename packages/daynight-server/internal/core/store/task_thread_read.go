package store

import (
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

// TaskPresence preserves deletion information until the caller has authorized access.
type TaskPresence struct {
	Found     bool
	DeletedAt *time.Time
}

// ThreadCredential retains the credential facts for final admission. A nil
// policy denotes a fixed profile or a credential awaiting the scope cutover.
type ThreadCredential struct {
	ExpiresAt   *time.Time
	ScopePolicy *scopepolicy.Policy
}
