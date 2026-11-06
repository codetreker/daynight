package store

import (
	"context"
	"encoding/json"
	"time"
)

// OAuthClient contains the registered public client's metadata and retention times.
type OAuthClient struct {
	ID                               string
	Metadata                         json.RawMessage
	CreatedAt, LastUsedAt, ExpiresAt time.Time
}

// OAuthClientWriter supplies both DAOs in one READ COMMITTED transaction.
// A DCR issuance pins the client in this scope before issuing a family.
type OAuthClientWriter interface {
	WriteOAuthClients(context.Context, func(OAuthClientScope) error) (Completion, error)
}
type OAuthClientScope interface {
	OAuthClientDAO() OAuthClientDAO
	CredentialFamilyDAO() CredentialFamilyDAO
}
type OAuthClientDAO interface {
	// InsertClient serializes the capacity check and allocation. It returns false
	// at capacity and does not insert. Capacity counts clients without active grants.
	InsertClient(context.Context, OAuthClient, int, time.Time) (bool, error)
	Client(context.Context, string, bool) (OAuthClient, error)
	// PinClient locks a DCR client through transaction completion and refreshes its
	// last-used time. Expired, unreferenced clients are treated as not found.
	PinClient(context.Context, string, time.Time) (OAuthClient, error)
	LockClientCapacity(context.Context) error
	ExpiredClients(context.Context, time.Time, int) ([]string, error)
	FreshTime(context.Context, time.Time) (time.Time, error)
	DeleteClient(context.Context, string) error
}
