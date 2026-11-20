package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// IdentityWriter binds identity and personal-team operations to one transaction.
// A scope and its DAOs are valid only during the callback.
type IdentityWriter interface {
	WriteIdentity(context.Context, func(IdentityScope) error) (Completion, error)
}

type IdentityScope interface {
	CredentialFamilyDAO() CredentialFamilyDAO
	IdentityDAO() IdentityDAO
	PersonalTeamDAO() PersonalTeamDAO
}

type IdentityDAO interface {
	CleanupCredentials(context.Context, time.Time) error
	// Login admission uses its post-lock database time for login expiry and the
	// application clock for session and PAT expiry.
	CleanupLoginCredentials(context.Context, time.Time, time.Time) error
	// AdmitLogin serializes capacity checks until the surrounding transaction
	// ends. The returned time is sampled after the lock is acquired. A nonempty
	// code is a rejection and must not be followed by cleanup or insertion.
	AdmitLogin(context.Context, []byte, int, int) (time.Time, string, error)
	InsertLogin(context.Context, model.LoginTransaction) error
	ConsumeLogin(context.Context, []byte, []byte, time.Time) (model.LoginTransaction, error)
	// UpsertUser synchronizes login profile fields atomically, retaining missing
	// values and keeping email verification paired with its address. It returns
	// the merged row. PatchUser instead applies explicit nulls as clears.
	UpsertUser(context.Context, model.User, time.Time) (model.User, error)
	// EnsureUser preserves an existing profile; inserted describes this transaction, not its commit.
	EnsureUser(context.Context, model.User, time.Time) (model.User, bool, error)
	PatchUser(context.Context, string, model.UserProfilePatch) (model.User, error)
	// LockProfileCredential shares native credential reads while excluding revocation and expiry writes.
	LockProfileCredential(context.Context, model.Principal, time.Time) error
	InsertSession(context.Context, model.Session) error
	Authenticate(context.Context, model.CredentialKind, []byte, time.Time) (model.Principal, error)
	IdentityUser(context.Context, string) (model.User, PersonalTeamFacts, error)
	IdentityPersonalTeam(context.Context, string) (PersonalTeamFacts, error)
	DeleteSession(context.Context, model.Principal) error
	LockSession(context.Context, model.Principal, time.Time) error
	InsertPAT(context.Context, model.PersonalAccessToken) error
	ListPATs(context.Context, string, time.Time) ([]model.PersonalAccessToken, error)
	DeletePAT(context.Context, string, string) error
	LockActivePAT(context.Context, string, string, time.Time) (model.PersonalAccessToken, error)
	SetPATExpiry(context.Context, string, *time.Time) (model.PersonalAccessToken, error)
	PruneDeviceRates(context.Context, time.Time) error
	IncrementDeviceRate(context.Context, model.DeviceRateBucket, time.Time) (int, error)
	PruneDevices(context.Context, time.Time) error
	InsertDevice(context.Context, model.DeviceAuthorization) error
	DeviceByUserCode(context.Context, string, string, bool) (model.DeviceAuthorization, error)
	LockDeviceByHash(context.Context, []byte) (model.DeviceAuthorization, error)
	SetDeviceDecision(context.Context, string, string, string) error
	DelayDevicePoll(context.Context, string, time.Time, bool) error
	ConsumeDevice(context.Context, string) error
}

// PATManagementDAO is the transaction-bound capability for account metadata.
// An IdentityDAO provided by the production identity scope also implements it.
type PATManagementDAO interface {
	FreshPATTime(context.Context, time.Time) (time.Time, error)
	ListAllPATs(context.Context, string) ([]model.PersonalAccessToken, error)
	ComparePATDescription(context.Context, string, string, *string, *string) (bool, error)
	PATExists(context.Context, string, string) (bool, error)
}

type PersonalTeamDAO interface {
	InsertPersonalTeam(context.Context, string, string, time.Time) (bool, error)
	InsertPersonalOwner(context.Context, string, string, time.Time) error
	PersonalTeam(context.Context, string) (PersonalTeamFacts, error)
}

// PersonalTeamFacts are the membership facts observed for a user's team.
// An empty ID means that the team does not exist.
type PersonalTeamFacts struct {
	ID              string
	MemberCount     int64
	OwnerAdminCount int64
}

// PreviewSSOWriter runs the complete operation in one transaction. A result
// from the callback is usable only when the completion reports committed.
type PreviewSSOWriter interface {
	WritePreviewSSO(context.Context, func(PreviewSSODAO) error) (Completion, error)
}

// PreviewSSODAO binds SSO record and existing session changes to one scope.
// Invalid, expired, consumed and revoked records return model.ErrNotFound.
// Methods locking both resources lock the login before the session.
type PreviewSSODAO interface {
	CleanupPreviewSSO(context.Context, time.Time) error
	InsertPreviewSSO(context.Context, model.PreviewSSOLogin) error
	StartPreviewSSO(context.Context, string, []byte, time.Time) (model.PreviewSSOLogin, error)
	// LockPreviewAuthorization samples issuance time after acquiring both locks.
	LockPreviewAuthorization(context.Context, string, []byte, model.Principal, time.Time) (time.Time, error)
	SetPreviewAuthorization(context.Context, string, model.Principal, []byte, time.Time) error
	RedeemPreviewSSO(context.Context, []byte, []byte, []byte, time.Time) (model.PreviewSSOLogin, model.Session, error)
	CompletePreviewSSO(context.Context, string, []byte, time.Time) (model.PreviewSSOLogin, error)
	// TakePreviewSSORetry consumes an unexpired login. An unbound login requires
	// both its ID and matching state; a bound login requires its original live
	// main session and a matching state when one is supplied.
	TakePreviewSSORetry(context.Context, string, []byte, model.Principal, time.Time) (model.PreviewSSOLogin, error)
	AuthenticatePreview(context.Context, []byte, time.Time) (model.Principal, time.Time, error)
}
