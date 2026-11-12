package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// GrantLifecycleWriter supplies a transaction-bound DAO. Token lookups before
// acquiring the grant lock are hints only and must be repeated after locking.
type GrantLifecycleWriter interface {
	WriteGrantLifecycle(context.Context, func(GrantLifecycleDAO) error) (Completion, error)
}

type OAuthRefresh struct {
	GrantID, ClientID string
	ExpiresAt         time.Time
	ConsumedAt        *time.Time
}

type OAuthRotation struct {
	Grant                            OAuthGrant
	OldHash, AccessHash, RefreshHash []byte
	AccessID                         string
	CreatedAt, AccessExpiresAt       time.Time
	GrantExpiresAt                   time.Time
}

type GrantLifecycleDAO interface {
	CredentialFamilyDAO
	LockOwnerSession(context.Context, model.Principal, time.Time) error
	FreshTime(context.Context, time.Time) (time.Time, error)
	Refresh(context.Context, []byte, bool) (OAuthRefresh, error)
	AccessGrant(context.Context, []byte) (string, error)
	RotateRefresh(context.Context, OAuthRotation) error
	OwnerGrants(context.Context, string) ([]OAuthGrant, error)
	PruneCredentials(context.Context, time.Time, int) (int, error)
}
