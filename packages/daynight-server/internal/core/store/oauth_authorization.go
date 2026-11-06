package store

import (
	"context"
	"encoding/json"
	"time"
)

// AuthorizationWriter binds request, client and credential operations to one transaction.
type AuthorizationWriter interface {
	WriteAuthorizations(context.Context, func(AuthorizationScope) error) (Completion, error)
}
type AuthorizationScope interface {
	AuthorizationDAO() AuthorizationDAO
	OAuthClientDAO() OAuthClientDAO
	CredentialFamilyDAO() CredentialFamilyDAO
	IdentityDAO() IdentityDAO
}
type OAuthAuthorization struct {
	ID                                                               string
	BindingHash                                                      []byte
	Client                                                           json.RawMessage
	ClientID, RedirectURI, Resource, Scope, Challenge, State, Status string
	StatePresent                                                     bool
	UserID, GrantID                                                  string
	CodeHash                                                         []byte
	CreatedAt, ExpiresAt, RetainUntil                                time.Time
	CodeExpiresAt                                                    *time.Time
}
type AuthorizationDAO interface {
	InsertAuthorization(context.Context, OAuthAuthorization, int, time.Time) (bool, error)
	Authorization(context.Context, string, bool) (OAuthAuthorization, error)
	AuthorizationByCode(context.Context, []byte, bool) (OAuthAuthorization, error)
	UpdateAuthorization(context.Context, OAuthAuthorization) error
	FreshTime(context.Context, time.Time) (time.Time, error)
	LockAuthorizationCapacity(context.Context) error
	AuthorizationCleanupCursor(context.Context) (int, error)
	SetAuthorizationCleanupCursor(context.Context, int) error
	ExpiredAuthorizations(context.Context, time.Time, int) ([]OAuthAuthorization, error)
	DeleteRetainedAuthorizations(context.Context, time.Time, int) (int, error)
}
